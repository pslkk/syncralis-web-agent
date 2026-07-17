import { config } from "../config.js";
import { researchQuery } from "../orchestrator.js";

async function fetchWeb({ entity, mentionedBrands }) {
  const bundle = await researchQuery({
    query: `${entity} official press release OR announcement OR news`,
    mentionedBrands,
    topN: 4,
  });
  return { platform: "web", method: "research_query", ...bundle };
}

async function fetchX({ entity, mentionedBrands }) {
  if (config.X_BEARER_TOKEN) {
    try {
      const resp = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(
          `from:${entity} OR "${entity}"`
        )}&max_results=10&tweet.fields=created_at,author_id`,
        {
          headers: { Authorization: `Bearer ${config.X_BEARER_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!resp.ok) {
        return {
          platform: "x",
          method: "official_api",
          ok: false,
          reason: `X API returned ${resp.status}. Check SYNCRALIS_WEB_AGENT_X_BEARER_TOKEN and your API access tier.`,
        };
      }
      const data = await resp.json();
      return { platform: "x", method: "official_api", ok: true, tweets: data.data || [] };
    } catch (err) {
      return { platform: "x", method: "official_api", ok: false, reason: String(err?.message || err) };
    }
  }

  try {
    const searchResult = await researchQuery({
      query: `${entity} official X twitter handle`,
      mentionedBrands,
      topN: 2,
    });
    return {
      platform: "x",
      method: "best_effort_browser",
      ok: true,
      caveat:
        "No X_BEARER_TOKEN configured — this is a best-effort web search for the account, not a direct read of the timeline. " +
        "X actively blocks unauthenticated/headless access, so live tweet content may be unavailable. " +
        "For reliable results, set SYNCRALIS_WEB_AGENT_X_BEARER_TOKEN (X API v2).",
      candidates: searchResult.sources,
    };
  } catch (err) {
    return { platform: "x", method: "best_effort_browser", ok: false, reason: String(err?.message || err) };
  }
}

async function fetchInstagram({ entity, mentionedBrands }) {
  if (config.INSTAGRAM_GRAPH_TOKEN) {
    return {
      platform: "instagram",
      method: "graph_api",
      ok: false,
      reason:
        "Instagram Graph API Business Discovery requires your own connected IG Business/Creator account ID " +
        "in addition to a token, and only returns data for other public Business/Creator accounts. " +
        "Set SYNCRALIS_WEB_AGENT_INSTAGRAM_BUSINESS_ACCOUNT_ID and wire the business_discovery field query in this function to enable it.",
    };
  }

  try {
    const searchResult = await researchQuery({
      query: `${entity} official Instagram account`,
      mentionedBrands,
      topN: 2,
    });
    return {
      platform: "instagram",
      method: "best_effort_browser",
      ok: true,
      caveat:
        "No Instagram Graph API token configured — this is a best-effort web search, not a direct read of the profile. " +
        "Instagram requires login for most content and blocks unauthenticated scraping, so results are likely incomplete.",
      candidates: searchResult.sources,
    };
  } catch (err) {
    return { platform: "instagram", method: "best_effort_browser", ok: false, reason: String(err?.message || err) };
  }
}

const PLATFORM_FETCHERS = { web: fetchWeb, x: fetchX, instagram: fetchInstagram };

export async function fetchUpdates({ entity, platforms = ["web", "x", "instagram"], mentionedBrands = [] }) {
  const results = await Promise.all(
    platforms
      .filter((p) => PLATFORM_FETCHERS[p])
      .map((p) => PLATFORM_FETCHERS[p]({ entity, mentionedBrands }))
  );
  return { entity, platforms: results };
}
