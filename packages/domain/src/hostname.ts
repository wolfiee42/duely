import { DomainError } from "./errors";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$|^xn--[a-z0-9-]{2,59}$/;

/**
 * Normalises and validates a hostname a firm wants to serve its portal on (FR-7.1).
 * Returns the lowercase hostname without scheme, port, path or trailing dot.
 * The platform's own domain and everything under it is reserved.
 */
export function parseCustomHostname(input: string, platformDomain: string): string {
  const invalid = () =>
    new DomainError(
      "domain.invalid_hostname",
      "validation",
      "Enter a domain like billing.yourfirm.com.",
    );

  let host = input.trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) host = host.replace(/^[a-z]+:\/\//, "");
  host = host.replace(/\/+$/, "").replace(/\.$/, "");
  if (!host || host.length > 253 || /[\s/:@?#*_]/.test(host)) throw invalid();

  const labels = host.split(".");
  if (!labels.every(Boolean)) throw invalid();
  // A bare apex such as `yourfirm.com` cannot hold a CNAME at most DNS providers, so a subdomain is required.
  if (labels.length < 3) {
    throw new DomainError(
      "domain.needs_subdomain",
      "validation",
      "Use a subdomain such as billing.yourfirm.com; a bare domain can't point to us.",
    );
  }
  if (!labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) throw invalid();

  const root = platformDomain.toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) {
    throw new DomainError(
      "domain.reserved",
      "validation",
      "That address belongs to us. Use a domain you own.",
    );
  }
  return host;
}
