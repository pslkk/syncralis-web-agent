import { newTaskSession, safeGoto } from "../browser.js";
import { scoreDomain } from "../trust.js";
import {
  sanitizeUntrustedText,
  annotateWithInjectionSignals,
  scanForInjectionSignals,
  UNTRUSTED_CONTENT_WARNING,
  HIDDEN_TEXT_SIGNAL,
} from "../security/promptInjection.js";
import { classifyVisibility, summarizeHiddenText } from "../security/textVisibility.js";
import { logEvent } from "../security/auditLog.js";

const MAX_TEXT_NODES_SCANNED = 800;
const MIN_HIDDEN_CANDIDATE_LENGTH = 3;

function collectRawTextStyleFacts([maxNodes, minLength]) {
  function effectiveBackgroundColor(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 25) {
      const cs = window.getComputedStyle(node);
      const bg = cs.backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\s*\)/.test(bg)) return bg;
      node = node.parentElement;
      depth += 1;
    }
    return "rgb(255, 255, 255)";
  }

  const out = [];
  if (!document.body) return out;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  let scanned = 0;
  while ((node = walker.nextNode()) && scanned < maxNodes) {
    const text = (node.nodeValue || "").trim();
    if (text.length < minLength) continue;
    const el = node.parentElement;
    if (!el) continue;
    scanned += 1;

    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    out.push({
      text,
      display: cs.display,
      visibility: cs.visibility,
      opacity: parseFloat(cs.opacity),
      fontSize: parseFloat(cs.fontSize),
      color: cs.color,
      effectiveBackgroundColor: effectiveBackgroundColor(el),
      clipPath: cs.clipPath,
      clip: cs.clip,
      overflow: cs.overflow,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }
  return out;
}

async function detectHiddenText(page) {
  try {
    const raw = await page.evaluate(collectRawTextStyleFacts, [
      MAX_TEXT_NODES_SCANNED,
      MIN_HIDDEN_CANDIDATE_LENGTH,
    ]);
    const entries = raw.map((fact) => ({ text: fact.text, reasons: classifyVisibility(fact) }));
    return summarizeHiddenText(entries);
  } catch {
    return { hiddenTextDetected: false, hiddenText: [], totalHiddenSegments: 0 };
  }
}

export async function openPage({ url, mentionedBrands = [] }) {
  const trust = await scoreDomain(url, { mentionedBrands });
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

    const hiddenTextResult = await detectHiddenText(session.page);

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

    const hiddenText = hiddenTextResult.hiddenText.map((h) => ({
      ...h,
      text: sanitizeUntrustedText(h.text, { maxLength: 200 }),
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
      hiddenTextDetected: hiddenTextResult.hiddenTextDetected,
      ...(hiddenTextResult.hiddenTextDetected
        ? { hiddenText, totalHiddenSegments: hiddenTextResult.totalHiddenSegments }
        : {}),
    };

    annotateWithInjectionSignals(
      payload,
      title,
      textPreview,
      ...clickableElements.map((c) => c.text),
      ...downloadableLinks.map((l) => l.text)
    );

    if (hiddenTextResult.hiddenTextDetected) {
      const existing = new Set(payload.injectionSignalsDetected || []);
      existing.add(HIDDEN_TEXT_SIGNAL);
      for (const h of hiddenText) {
        for (const sig of scanForInjectionSignals(h.text)) existing.add(sig);
      }
      payload.injectionSignalsDetected = Array.from(existing);
    }

    if (payload.injectionSignalsDetected) {
      await logEvent({
        action: "prompt_injection_signal_detected",
        url,
        signals: payload.injectionSignalsDetected,
        hiddenTextSegments: hiddenTextResult.totalHiddenSegments || 0,
      });
    }

    return payload;
  } finally {
    await session.close();
  }
}
