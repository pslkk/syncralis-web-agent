import { newTaskSession, safeGoto } from "../browser.js";
import { scoreDomain } from "../trust.js";
import {
  sanitizeUntrustedText,
  annotateWithInjectionSignals,
  UNTRUSTED_CONTENT_WARNING,
} from "../security/promptInjection.js";
import { logEvent } from "../security/auditLog.js";

export async function openPage({ url, mentionedBrands = [] }) {
  const trust = scoreDomain(url, { mentionedBrands });
  const session = await newTaskSession();
  try {
    const response = await safeGoto(session.page, url);
    const status = response?.status();
    const rawTitle = await session.page.title();

    const rawText = await session.page.evaluate(() => document.body?.innerText || "");
    const rawClickables = await session.page.$$eval(
      "a, button",
      (els) =>
        els
          .slice(0, 200)
          .map((el, i) => ({
            index: i,
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().slice(0, 80) || "",
            href: el.getAttribute("href") || null,
          }))
          .filter((c) => c.text || c.href)
    );

    const rawDownloadableLinks = await session.page.$$eval(
      "a[href]",
      (els) => {
        const exts = ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "jpg", "jpeg", "png", "gif", "webp", "zip"];
        const re = new RegExp(`\\.(${exts.join("|")})(\\?|#|$)`, "i");
        return els
          .map((el) => ({ href: el.href, text: el.textContent?.trim().slice(0, 100) || "" }))
          .filter((l) => re.test(l.href));
      }
    );

    const title = sanitizeUntrustedText(rawTitle, { maxLength: 300 });
    const textPreview = sanitizeUntrustedText(rawText, { maxLength: 4000 });
    const clickableElements = rawClickables.slice(0, 40).map((c) => ({
      ...c,
      text: sanitizeUntrustedText(c.text, { maxLength: 80 }),
    }));
    const downloadableLinks = rawDownloadableLinks.slice(0, 30).map((l) => ({
      ...l,
      text: sanitizeUntrustedText(l.text, { maxLength: 100 }),
    }));

    const payload = {
      url,
      status,
      title,
      trust,
      contentWarning: UNTRUSTED_CONTENT_WARNING,
      textPreview,
      clickableElements,
      downloadableLinks,
    };

    annotateWithInjectionSignals(
      payload,
      title,
      textPreview,
      ...clickableElements.map((c) => c.text),
      ...downloadableLinks.map((l) => l.text)
    );

    if (payload.injectionSignalsDetected) {
      await logEvent({
        action: "prompt_injection_signal_detected",
        url,
        signals: payload.injectionSignalsDetected,
      });
    }

    return payload;
  } finally {
    await session.close();
  }
}
