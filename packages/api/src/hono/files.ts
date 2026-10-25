import type { ModelClient } from "@repo/ai";
import { DomainError } from "@repo/domain";
import { Hono } from "hono";

import type { WithDb } from "../db";
import type { FilesPort } from "../services";
import { PORTAL_COOKIE, readCookie } from "../trpc/portal-context";
import { requestScope } from "../usecases/domains";
import { extractInvoiceFile, type ExtractMediaType } from "../usecases/extraction";
import { getFirmLogoKey, setFirmLogo } from "../usecases/firm";
import { renderInvoicePdf } from "../usecases/invoice-pdf";
import { loadSession } from "../usecases/portal-auth";
import { authenticateStaff, requireHostKind, requireStaff, type AppEnv } from "./middleware";

// Type allowlist plus magic bytes, so a renamed file or a lying Content-Type is rejected.
// SVG is excluded on purpose: it can carry script.
const IMAGE_TYPES = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
} as const;

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function matchesMagic(bytes: Uint8Array, type: keyof typeof IMAGE_TYPES) {
  const { magic } = IMAGE_TYPES[type];
  if (!magic.every((b, i) => bytes[i] === b)) return false;
  // WebP is RIFF....WEBP
  return type !== "image/webp" || new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}

/** Reads the body but gives up as soon as it passes the cap, so an oversized upload is never buffered whole. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export const MAX_EXTRACT_BYTES = 10 * 1024 * 1024;

/** Invoice uploads for extraction: PDF or a photo/scan, checked by content as well as declared type. */
function sniff(bytes: Uint8Array): ExtractMediaType | null {
  if (bytes.length > 4 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-")
    return "application/pdf";
  for (const type of Object.keys(IMAGE_TYPES) as Array<keyof typeof IMAGE_TYPES>) {
    if (matchesMagic(bytes, type)) return type;
  }
  return null;
}

export function fileRoutes(deps: {
  withDb: WithDb;
  files: FilesPort;
  /** Read per request, so the model in use is always the configured one. */
  ai: { model: ModelClient | null };
  auth: { baseURL: string; secret: string };
}) {
  const app = new Hono<AppEnv>();

  // Owner uploads the logo as the raw request body, with its Content-Type.
  app.post("/files/logo", requireHostKind("app"), requireStaff(deps), async (c) => {
    const staff = c.var.staff;
    if (staff.role !== "owner") return c.json({ error: "owner_required" }, 403);
    const type = (c.req.header("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase() as keyof typeof IMAGE_TYPES;
    if (!(type in IMAGE_TYPES)) return c.json({ error: "unsupported_type" }, 415);
    const bytes = await readCapped(c.req.raw, MAX_LOGO_BYTES);
    if (!bytes) return c.json({ error: "too_large" }, 413);
    if (!matchesMagic(bytes, type)) return c.json({ error: "not_an_image" }, 415);

    // Random key under the tenant; nothing from the request is used in the path.
    const key = `firms/${staff.tenantId}/logo/${crypto.randomUUID()}.${IMAGE_TYPES[type].ext}`;
    await deps.files.put(key, bytes, type);
    await deps.withDb((db) =>
      setFirmLogo(
        db,
        {
          tenantId: staff.tenantId,
          type: "member",
          id: staff.memberId,
          requestId: c.var.requestId,
        },
        key,
      ),
    );
    return c.json({ ok: true });
  });

  // Upload an invoice (PDF or image) to be read into a draft. Any member may; nothing is sent (FR-11.4).
  app.post("/files/extract", requireHostKind("app"), requireStaff(deps), async (c) => {
    const staff = c.var.staff;
    const bytes = await readCapped(c.req.raw, MAX_EXTRACT_BYTES);
    if (!bytes) return c.json({ error: "too_large" }, 413);
    const mediaType = sniff(bytes);
    if (!mediaType) return c.json({ error: "unsupported_type" }, 415);
    const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (declared !== mediaType) return c.json({ error: "type_mismatch" }, 415);

    const actor = {
      tenantId: staff.tenantId,
      type: "member" as const,
      id: staff.memberId,
      requestId: c.var.requestId,
    };
    const result = await extractInvoiceFile(
      { scope: requestScope(deps.withDb), files: deps.files, model: deps.ai.model },
      actor,
      { bytes, mediaType },
    );
    // A failed read is not an error for the user: they fill the form in by hand (FR-11.20).
    return c.json(result);
  });

  // Branding is shown before sign-in on the portal, so the portal host serves it without a session.
  // The tenant comes from the host, never from the URL.
  app.get("/logo", async (c) => {
    const tenantId = c.var.host.hostKind === "portal" ? c.var.host.tenantId : null;
    if (!tenantId) return c.text("Not Found", 404);
    const key = await deps.withDb((db) => getFirmLogoKey(db, tenantId));
    const object = key ? await deps.files.get(key) : null;
    if (!object) return c.text("Not Found", 404);
    return new Response(object.body as BodyInit, {
      headers: {
        "content-type": object.contentType,
        "content-length": String(object.size),
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=300",
      },
    });
  });

  // The invoice PDF. App host: any member of the firm (drafts included). Portal host: the contact's own client only.
  // Either way the tenant is the session's or the host's, never the URL's.
  app.get("/invoices/:id/pdf", async (c) => {
    const invoiceId = c.req.param("id");
    const host = c.var.host;
    let tenantId: string;
    let scope: { clientId?: string; includeDraft: boolean };

    if (host.hostKind === "app") {
      const staff = await authenticateStaff(deps, c.req.raw.headers);
      if (staff === "unauthenticated") return c.json({ error: "unauthenticated" }, 401);
      if (staff === "no_firm") return c.json({ error: "no_firm" }, 403);
      tenantId = staff.tenantId;
      scope = { includeDraft: true };
    } else if (host.hostKind === "portal" && host.tenantId) {
      const raw = readCookie(c.req.header("cookie") ?? null, PORTAL_COOKIE);
      const identity = raw ? await deps.withDb((db) => loadSession(db, host.tenantId!, raw)) : null;
      if (!identity) return c.json({ error: "unauthenticated" }, 401);
      tenantId = host.tenantId;
      scope = { clientId: identity.clientId, includeDraft: false };
    } else {
      return c.text("Not Found", 404);
    }

    try {
      const bytes = await deps.withDb((db) => renderInvoicePdf(db, tenantId, invoiceId, scope));
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="invoice-${invoiceId.slice(0, 8)}.pdf"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof DomainError && error.kind === "not_found")
        return c.text("Not Found", 404);
      throw error;
    }
  });

  return app;
}
