export interface DomainHintInput {
  status: "pending" | "verifying" | "active" | "failed";
  errors: string[];
  /** Minutes since the firm added the domain. */
  ageMinutes: number;
}

/**
 * Plain-language next step for a domain that is not live yet (FR-7.8). Matches on Cloudflare's wording
 * only loosely; when nothing matches, the hint falls back to what the status itself implies.
 */
export function domainHint({ status, errors, ageMinutes }: DomainHintInput): string | null {
  if (status === "active") return null;
  const text = errors.join(" ").toLowerCase();

  if (status === "failed") {
    return "We couldn't finish setting this up. Check the record below, then remove the domain and add it again.";
  }
  if (/caa/.test(text)) {
    return "A CAA record on your domain is blocking certificate issuance. Remove it, or allow Cloudflare's certificate authorities.";
  }
  if (/cname|resolve|dns|not point|does not/.test(text)) {
    return "We can't see the record yet. Make sure the name and target match exactly and the record is set to DNS only (no proxy). DNS changes can take up to an hour.";
  }
  if (status === "verifying") {
    return "The record is correct. We're issuing your certificate, which usually takes a few minutes.";
  }
  if (ageMinutes >= 15) {
    return "Still waiting for the record. If your DNS provider proxies traffic for it, switch the record to DNS only, and check for typos in the name and target.";
  }
  return "Waiting for your DNS record. This can take a few minutes, sometimes up to an hour.";
}
