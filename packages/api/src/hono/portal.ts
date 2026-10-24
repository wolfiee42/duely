import { Hono } from "hono";

import type { WithDb } from "../db";
import { PORTAL_COOKIE, readCookie } from "../trpc/portal-context";
import { consumeLink, endSession } from "../usecases/portal-auth";
import { requireHostKind, type AppEnv } from "./middleware";

export function portalRoutes(deps: { withDb: WithDb }) {
  const app = new Hono<AppEnv>();

  // GET /api/portal/auth/:token — consume a magic link, set the host-only session cookie, redirect.
  // Not a state change a third party can force: the token is unguessable and unknown tokens just redirect.
  app.get("/portal/auth/:token", requireHostKind("portal"), async (c) => {
    const tenantId = c.var.host.tenantId!;
    const result = await deps.withDb((db) => consumeLink(db, tenantId, c.req.param("token")));
    if (!result) return c.redirect("/portal/login?link=invalid", 302);

    // Rotation: the previous session in this browser is ended when a new one is issued.
    const previous = readCookie(c.req.header("cookie") ?? null, PORTAL_COOKIE);
    if (previous) await deps.withDb((db) => endSession(db, tenantId, previous));

    const secure = new URL(c.req.url).protocol === "https:";
    // No Domain attribute: the cookie is host-only and never reaches the app host or another tenant (FR-1.7).
    c.header(
      "set-cookie",
      `${PORTAL_COOKIE}=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${result.expiresAt.toUTCString()}${secure ? "; Secure" : ""}`,
    );
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
    return c.redirect(result.invoiceId ? `/portal/invoices/${result.invoiceId}` : "/portal", 302);
  });

  return app;
}
