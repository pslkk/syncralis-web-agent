import { runWebSearch } from "./searchProviders/index.js";
import { scoreDomain } from "../trust.js";
import {
  sanitizeUntrustedText,
  annotateWithInjectionSignals,
  UNTRUSTED_CONTENT_WARNING,
} from "../security/promptInjection.js";
import { logEvent } from "../security/auditLog.js";
import { config } from "../config.js";

export async function webSearch({ query, mentionedBrands = [], maxResults = 8 }) {
  const startedAt = Date.now();

  let outcome;
  try {
    outcome = await runWebSearch({
      query,
      maxResults,
      safeSearch: config.WEB_SEARCH_SAFE_SEARCH,
      timeoutMs: config.WEB_SEARCH_TIMEOUT_MS,
    });
  } catch (err) {
    await logEvent({
      action: "web_search_failed",
      query,
      latencyMs: Date.now() - startedAt,
      error: String(err?.message || err),
      ...(err?.attempts ? { attempts: err.attempts } : {}),
    });
    throw err;
  }

  const results = outcome.results
    .filter((r) => r.href && /^https?:\/\//i.test(r.href))
    .slice(0, maxResults)
    .map((r) => {
      const trust = scoreDomain(r.href, { mentionedBrands });
      return {
        title: sanitizeUntrustedText(r.title, { maxLength: 200 }),
        href: r.href,
        snippet: sanitizeUntrustedText(r.snippet || "", { maxLength: 500 }),
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
        trust,
      };
    })
    .sort((a, b) => b.trust.score - a.trust.score);

  const payload = {
    query,
    provider: outcome.provider,
    contentWarning: UNTRUSTED_CONTENT_WARNING,
    results,
  };

  annotateWithInjectionSignals(
    payload,
    ...results.map((r) => r.title),
    ...results.map((r) => r.snippet)
  );

  await logEvent({
    action: "web_search",
    query,
    provider: outcome.provider,
    resultCount: results.length,
    latencyMs: Date.now() - startedAt,
    ...(outcome.attempts?.some((a) => !a.ok) ? { degraded: true, attempts: outcome.attempts } : {}),
  });

  if (payload.injectionSignalsDetected) {
    await logEvent({
      action: "prompt_injection_signal_detected",
      source: "web_search",
      query,
      signals: payload.injectionSignalsDetected,
    });
  }

  return payload;
}
