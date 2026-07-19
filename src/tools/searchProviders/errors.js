export class SearchProviderError extends Error {
  constructor(message, { status, kind, retryAfterMs } = {}) {
    super(message);
    this.name = "SearchProviderError";
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(resp) {
  const header = resp.headers?.get?.("retry-after");
  if (!header) return undefined;

  const asSeconds = Number(header);
  if (!Number.isNaN(asSeconds)) return Math.max(0, asSeconds * 1000);

  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());

  return undefined;
}

export async function errorFromResponse(resp, providerLabel, keyEnvVarHint) {
  if (resp.status === 401 || resp.status === 403) {
    return new SearchProviderError(
      `${providerLabel} rejected the request (HTTP ${resp.status}) — check ${keyEnvVarHint} is set and valid.`,
      { status: resp.status, kind: "auth" }
    );
  }
  if (resp.status === 429) {
    return new SearchProviderError(`${providerLabel} rate limit exceeded (HTTP 429).`, {
      status: 429,
      kind: "rate_limit",
      retryAfterMs: parseRetryAfterMs(resp),
    });
  }
  if (resp.status >= 500) {
    return new SearchProviderError(`${providerLabel} server error (HTTP ${resp.status}).`, {
      status: resp.status,
      kind: "server",
    });
  }

  let detail = "";
  try {
    detail = (await resp.text()).slice(0, 300);
  } catch {
    // ignore — best-effort detail only
  }
  return new SearchProviderError(
    `${providerLabel} returned an unexpected status (HTTP ${resp.status}).${detail ? ` ${detail}` : ""}`,
    { status: resp.status, kind: "invalid_response" }
  );
}
