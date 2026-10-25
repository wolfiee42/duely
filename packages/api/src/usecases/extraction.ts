import { ExtractionOutput, EXTRACTION_SYSTEM, extractionContent, type ModelClient } from "@repo/ai";
import { withTenant, type Db } from "@repo/db";
import { aiRuns, clients, documents, reviewItems } from "@repo/db/schema";
import { DomainError, lineAmount, parseQuantity } from "@repo/domain";
import { and, eq, isNull } from "drizzle-orm";

import type { FilesPort } from "../services";
import { runAi } from "./ai";
import { audit, type Actor } from "./audit";
import type { TenantScope } from "./domains";
import { createDraft, type DraftInput } from "./invoices";

// SPEC 5.1. A PDF or image becomes a *draft* the firm reviews (FR-11.4): extraction can never send anything.

export const EXTRACT_MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type ExtractMediaType = (typeof EXTRACT_MEDIA_TYPES)[number];
const LOW_CONFIDENCE = 0.7;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Do the line items add up to the total printed on the document? `null` when no total was stated (FR-11.2).
 * Quantities the model reports with more precision than we store count as not adding up.
 */
export function reconcile(out: Pick<ExtractionOutput, "items" | "stated_total_minor">) {
  let computed = 0;
  let exact = true;
  for (const item of out.items) {
    const q = parseQuantity(String(item.quantity));
    if (!q) {
      exact = false;
      continue;
    }
    computed += lineAmount(q, item.unit_amount_minor);
  }
  return {
    computedTotalMinor: computed,
    reconciles:
      out.stated_total_minor === null ? null : exact && computed === out.stated_total_minor,
  };
}

/** Fields the model was unsure about, and a missing item list, are what the reviewer should look at first (FR-11.3). */
export function lowConfidenceFields(out: ExtractionOutput): string[] {
  const low = Object.entries(out.field_confidence)
    .filter(([, c]) => c < LOW_CONFIDENCE)
    .map(([k]) => k);
  if (out.items.length === 0 && !low.includes("items")) low.push("items");
  return low;
}

/** Stores the upload, asks the model to read it, and returns what it found for the person to confirm. */
export async function extractInvoiceFile(
  deps: { scope: TenantScope; files: FilesPort; model: ModelClient | null },
  actor: Actor,
  file: { bytes: Uint8Array; mediaType: ExtractMediaType },
) {
  // Random key under the tenant; nothing from the request names the path.
  const key = `firms/${actor.tenantId}/extraction/${crypto.randomUUID()}`;
  await deps.files.put(key, file.bytes, file.mediaType);
  const documentId = await deps.scope(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId: actor.tenantId,
        kind: "extraction_source",
        storageKey: key,
        contentType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
      })
      .returning({ id: documents.id });
    await audit(tx, actor, "invoice.extraction_uploaded", { type: "document", id: doc!.id });
    return doc!.id;
  });

  const result = await runAi(deps.scope, deps.model, {
    tenantId: actor.tenantId,
    purpose: "extraction",
    system: EXTRACTION_SYSTEM,
    content: extractionContent({
      type: "file",
      mediaType: file.mediaType,
      base64: toBase64(file.bytes),
    }),
    hashText: `${file.mediaType}:${file.bytes.byteLength}:${documentId}`,
    schema: ExtractionOutput,
    maxTokens: 4000,
  });
  if (!result.ok) return { ok: false as const, reason: result.reason, documentId };

  const out = result.output;
  const known = await deps.scope(actor.tenantId, (tx) =>
    tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(isNull(clients.archivedAt)),
  );
  const wanted = out.client_name?.trim().toLowerCase();
  const suggested = wanted
    ? (known.find((c) => c.name.toLowerCase() === wanted) ??
      known.find(
        (c) => c.name.toLowerCase().includes(wanted) || wanted.includes(c.name.toLowerCase()),
      ))
    : undefined;

  return {
    ok: true as const,
    documentId,
    runId: result.runId,
    extraction: out,
    lowFields: lowConfidenceFields(out),
    ...reconcile(out),
    suggestedClientId: suggested?.id ?? null,
  };
}

/**
 * Turns a confirmed extraction into a draft invoice. The figures come from the person's form, but whether it
 * needed a second look is judged against what the model originally read, which is loaded here rather than
 * trusted from the browser. A draft that was uncertain or does not add up also lands in the review queue.
 */
export async function createDraftFromExtraction(
  db: Db,
  actor: Actor,
  input: DraftInput & { documentId: string; runId: string },
) {
  const run = await withTenant(db, actor.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(aiRuns)
      .where(
        and(eq(aiRuns.id, input.runId), eq(aiRuns.purpose, "extraction"), eq(aiRuns.status, "ok")),
      );
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, input.documentId));
    return row && doc ? ExtractionOutput.safeParse(row.output) : null;
  });
  if (!run?.success) {
    throw new DomainError(
      "extraction.not_found",
      "not_found",
      "That upload is no longer available.",
    );
  }

  const { documentId, runId, ...draft } = input;
  const created = await createDraft(db, actor, draft, { source: "ai_extraction", documentId });

  const lowFields = lowConfidenceFields(run.data);
  const { reconciles } = reconcile(run.data);
  if (lowFields.length || reconciles === false) {
    await withTenant(db, actor.tenantId, (tx) =>
      tx.insert(reviewItems).values({
        tenantId: actor.tenantId,
        kind: "extraction_review",
        invoiceId: created.id,
        aiRunId: runId,
        payload: { lowFields, reconciles, statedTotalMinor: run.data.stated_total_minor },
      }),
    );
  }
  return { ...created, needsReview: lowFields.length > 0 || reconciles === false };
}
