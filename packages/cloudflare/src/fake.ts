import { CloudflareApiError } from "./client";
import type { CloudflareClient, CustomHostname } from "./types";

export interface FakeCloudflare extends CloudflareClient {
  hostnames: Map<string, CustomHostname>;
  /** Test control: move a hostname to a state, as if DNS and the certificate progressed. */
  set(
    hostname: string,
    patch: Partial<Pick<CustomHostname, "status" | "sslStatus" | "errors">>,
  ): void;
  /** Test control: make the next call of this kind throw. */
  failNext(kind: "create" | "get" | "delete", error?: Error): void;
}

/** In-memory Cloudflare for default test runs (no remote calls). New hostnames start `pending`. */
export function createFakeCloudflare(): FakeCloudflare {
  const hostnames = new Map<string, CustomHostname>();
  const failures: Record<string, Error | undefined> = {};
  let n = 0;
  const take = (kind: string) => {
    const error = failures[kind];
    failures[kind] = undefined;
    if (error) throw error;
  };
  const byName = (hostname: string) => [...hostnames.values()].find((h) => h.hostname === hostname);
  return {
    hostnames,
    set(hostname, patch) {
      const found = byName(hostname);
      if (!found) throw new Error(`no such hostname ${hostname}`);
      hostnames.set(found.id, { ...found, ...patch });
    },
    failNext(kind, error = new CloudflareApiError(500, undefined, "boom")) {
      failures[kind] = error;
    },
    async createCustomHostname(hostname) {
      take("create");
      if (byName(hostname)) throw new CloudflareApiError(409, 1406, "Duplicate custom hostname");
      const created: CustomHostname = {
        id: `ch_fake_${++n}`,
        hostname,
        status: "pending",
        sslStatus: "initializing",
        errors: [],
      };
      hostnames.set(created.id, created);
      return created;
    },
    async getCustomHostname(id) {
      take("get");
      return hostnames.get(id) ?? null;
    },
    async deleteCustomHostname(id) {
      take("delete");
      hostnames.delete(id);
    },
  };
}
