import { newTaskSession, safeGoto } from "../../browser.js";
import { SearchProviderError } from "./errors.js";

export const LEGACY_BROWSER_ENDPOINT = "https://duckduckgo.com/html/";

export async function searchLegacyBrowser({ query, maxResults }) {
  const session = await newTaskSession();
  try {
    const engineUrl = `${LEGACY_BROWSER_ENDPOINT}?q=${encodeURIComponent(query)}`;
    await safeGoto(session.page, engineUrl);

    const rawResults = await session.page.$$eval("a.result__a", (els) =>
      els.map((el) => ({
        title: el.textContent?.trim() || "",
        href: el.getAttribute("href") || "",
      }))
    );

    const results = rawResults
      .filter((r) => r.href && r.href.startsWith("http"))
      .slice(0, maxResults)
      .map((r) => ({ title: r.title, href: r.href, snippet: "" }));

    if (results.length === 0) {
      throw new SearchProviderError(
        "Legacy browser search returned zero results — likely blocked by anti-bot protection.",
        { kind: "invalid_response" }
      );
    }

    return results;
  } catch (err) {
    if (err instanceof SearchProviderError) throw err;
    throw new SearchProviderError(`Legacy browser search failed: ${err?.message || err}`, {
      kind: "network",
    });
  } finally {
    await session.close();
  }
}
