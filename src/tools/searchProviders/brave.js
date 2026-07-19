import { SearchProviderError, errorFromResponse } from "./errors.js";

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function clampCount(maxResults) {
  return Math.min(Math.max(Number(maxResults) || 8, 1), 20);
}

export async function searchBrave({ apiKey, query, maxResults, safeSearch, timeoutMs }) {
  if (!apiKey) {
    throw new SearchProviderError("Brave Search API key not configured.", { kind: "auth" });
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(clampCount(maxResults)));
  url.searchParams.set("safesearch", safeSearch || "moderate");

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new SearchProviderError(`Brave Search request timed out after ${timeoutMs}ms.`, {
        kind: "timeout",
      });
    }
    throw new SearchProviderError(`Network error contacting Brave Search: ${err?.message || err}`, {
      kind: "network",
    });
  }

  if (!resp.ok) {
    throw await errorFromResponse(resp, "Brave Search", "SYNCRALIS_WEB_AGENT_BRAVE_API_KEY");
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new SearchProviderError("Brave Search returned a response that was not valid JSON.", {
      kind: "invalid_response",
    });
  }

  const results = data?.web?.results;
  const list = Array.isArray(results) ? results : [];
  return list
    .filter((r) => r && typeof r.url === "string" && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      href: r.url,
      snippet: typeof r.description === "string" ? r.description : "",
      ...(r.age ? { publishedDate: String(r.age) } : {}),
    }));
}
