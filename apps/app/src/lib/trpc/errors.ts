/**
 * Reads the code from a tRPC failure on either side: the in-process caller throws a `TRPCError`
 * (code on the error, domain error as `cause`), the browser client a `TRPCClientError` (both in `data`).
 */
export function trpcErrorInfo(error: unknown): { code: string | null; domainCode: string | null } {
  const e = error as {
    code?: string;
    cause?: { code?: string };
    data?: { code?: string; domainCode?: string | null };
  } | null;
  return {
    code: e?.data?.code ?? e?.code ?? null,
    domainCode: e?.data?.domainCode ?? e?.cause?.code ?? null,
  };
}
