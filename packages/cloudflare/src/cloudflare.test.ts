import { describe, expect, it } from "vite-plus/test";

import { CloudflareApiError, createCloudflareClient, toCustomHostname } from "./client";

const raw = (status: string, ssl?: string, extra = {}) => ({
  id: "ch1",
  hostname: "billing.acme.com",
  status,
  ssl: ssl ? { status: ssl } : undefined,
  ...extra,
});

describe("toCustomHostname", () => {
  it.each([
    [raw("pending", "initializing"), "pending"],
    [raw("pending", "pending_validation"), "pending"],
    [raw("active", "pending_issuance"), "verifying"],
    [raw("active", "pending_deployment"), "verifying"],
    [raw("active", "active"), "active"],
    [raw("pending", "validation_timed_out"), "failed"],
    [raw("active", "expired"), "failed"],
    [raw("blocked", "active"), "failed"],
    [raw("moved"), "failed"],
  ])("maps %j to %s", (input, expected) => {
    expect(toCustomHostname(input).status).toBe(expected);
  });

  it("collects verification and certificate errors", () => {
    const out = toCustomHostname({
      ...raw("pending", "pending_validation"),
      verification_errors: ["custom hostname does not CNAME to this zone."],
      ssl: { status: "pending_validation", validation_errors: [{ message: "http check failed" }] },
    });
    expect(out.errors).toEqual([
      "custom hostname does not CNAME to this zone.",
      "http check failed",
    ]);
  });
});

describe("createCloudflareClient", () => {
  function recorder(respond: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return { calls, client: createCloudflareClient("tok", "zone1", fetchImpl) };
  }
  const ok = (result: unknown) => Response.json({ success: true, result });

  it("creates with http validation and a bearer token", async () => {
    const { calls, client } = recorder(() => ok(raw("pending", "initializing")));
    const out = await client.createCustomHostname("billing.acme.com");
    expect(out.status).toBe("pending");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      hostname: "billing.acme.com",
      ssl: { method: "http", type: "dv" },
    });
  });

  it("returns null for a hostname Cloudflare no longer has, and delete tolerates it", async () => {
    const { client } = recorder(() => new Response("{}", { status: 404 }));
    expect(await client.getCustomHostname("gone")).toBeNull();
    await expect(client.deleteCustomHostname("gone")).resolves.toBeUndefined();
  });

  it("surfaces API errors with the Cloudflare code", async () => {
    const { client } = recorder(() =>
      Response.json(
        { success: false, errors: [{ code: 1406, message: "Duplicate custom hostname" }] },
        { status: 409 },
      ),
    );
    const error = await client.createCustomHostname("x.acme.com").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).isDuplicate).toBe(true);
  });
});
