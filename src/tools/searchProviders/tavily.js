import { SearchProviderError, errorFromResponse } from "./errors.js";

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

function clampMaxResults(maxResults) {
  return Math.min(Math.max(Number(maxResults) || 8, 1), 20);
}

export async function searchTavily({ apiKey, query, maxResults, timeoutMs }) {
  if (!apiKey) {
    throw new SearchProviderError("Tavily API key not configured.", { kind: "auth" });
  }

  let resp;
  try {
    resp = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: clampMaxResults(maxResults),
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new SearchProviderError(`Tavily request timed out after ${timeoutMs}ms.`, {
        kind: "timeout",
      });
    }
    throw new SearchProviderError(`Network error contacting Tavily: ${err?.message || err}`, {
      kind: "network",
    });
  }

  if (!resp.ok) {
    throw await errorFromResponse(resp, "Tavily", "SYNCRALIS_WEB_AGENT_TAVILY_API_KEY");
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new SearchProviderError("Tavily returned a response that was not valid JSON.", {
      kind: "invalid_response",
    });
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => r && typeof r.url === "string" && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === "string" ? r.title : "",
      href: r.url,
      snippet: typeof r.content === "string" ? r.content : "",
      ...(r.published_date ? { publishedDate: String(r.published_date) } : {}),
    }));
}
