import { webSearch } from "./tools/search.js";
import { openPage } from "./tools/openPage.js";
import { trustThreshold } from "./trust.js";
import { config } from "./config.js";
import { UNTRUSTED_CONTENT_WARNING } from "./security/promptInjection.js";

const CONCURRENCY = config.CONCURRENCY;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx).catch((err) => ({
        error: String(err?.message || err),
      }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function researchQuery({ query, mentionedBrands = [], topN = 4 }) {
  const { results } = await webSearch({ query, mentionedBrands, maxResults: 10 });
  const threshold = trustThreshold();
  const candidates = results.slice(0, topN);

  const pages = await mapWithConcurrency(candidates, CONCURRENCY, async (candidate) => {
    const page = await openPage({ url: candidate.href, mentionedBrands });
    return { candidate, page };
  });

  const ranked = pages
    .filter((p) => !p.error)
    .sort((a, b) => b.page.trust.score - a.page.trust.score);

  const sources = ranked.map(({ candidate, page }) => ({
    title: candidate.title,
    url: candidate.href,
    trust: page.trust,
    autoApproved: page.trust.score >= threshold,
    title_page: page.title,
    textPreview: page.textPreview,
    clickableElements: page.clickableElements,
    ...(page.injectionSignalsDetected
      ? { injectionSignalsDetected: page.injectionSignalsDetected }
      : {}),
  }));

  const injectionSignalsDetected = sources
    .filter((s) => s.injectionSignalsDetected)
    .map((s) => ({ url: s.url, signals: s.injectionSignalsDetected }));

  return {
    query,
    trustThreshold: threshold,
    contentWarning: UNTRUSTED_CONTENT_WARNING,
    sources,
    ...(injectionSignalsDetected.length > 0 ? { injectionSignalsDetected } : {}),
  };
}
