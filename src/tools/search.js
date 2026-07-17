import { newTaskSession, safeGoto } from "../browser.js";
import { scoreDomain } from "../trust.js";
import {
  sanitizeUntrustedText,
  annotateWithInjectionSignals,
  UNTRUSTED_CONTENT_WARNING,
} from "../security/promptInjection.js";
import { logEvent } from "../security/auditLog.js";

export async function webSearch({ query, mentionedBrands = [], maxResults = 8 }) {
  const session = await newTaskSession();
  try {
    const engineUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await safeGoto(session.page, engineUrl);

    const rawResults = await session.page.$$eval(
      "a.result__a",
      (els) =>
        els.map((el) => ({
          title: el.textContent?.trim() || "",
          href: el.getAttribute("href") || "",
        }))
    );

    const results = rawResults
      .filter((r) => r.href && r.href.startsWith("http"))
      .slice(0, maxResults)
      .map((r) => {
        const trust = scoreDomain(r.href, { mentionedBrands });
        return { ...r, title: sanitizeUntrustedText(r.title, { maxLength: 200 }), trust };
      })
      .sort((a, b) => b.trust.score - a.trust.score);

    const payload = {
      query,
      contentWarning: UNTRUSTED_CONTENT_WARNING,
      results,
    };

    annotateWithInjectionSignals(payload, ...results.map((r) => r.title));

    if (payload.injectionSignalsDetected) {
      await logEvent({
        action: "prompt_injection_signal_detected",
        url: engineUrl,
        signals: payload.injectionSignalsDetected,
      });
    }

    return payload;
  } finally {
    await session.close();
  }
}
