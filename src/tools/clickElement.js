import { newTaskSession, safeGoto } from "../browser.js";
import { textLocator } from "./textLocator.js";
import {
  sanitizeUntrustedText,
  annotateWithInjectionSignals,
  UNTRUSTED_CONTENT_WARNING,
} from "../security/promptInjection.js";
import { logEvent } from "../security/auditLog.js";

export async function clickElement({ url, matchText, selector }) {
  const session = await newTaskSession();
  try {
    await safeGoto(session.page, url);

    let locator;
    if (selector) {
      locator = session.page.locator(selector).first();
    } else if (matchText) {
      locator = textLocator(session.page, matchText);
    } else {
      throw new Error("Provide either matchText or selector");
    }

    await locator.waitFor({ state: "visible", timeout: 10000 });
    await Promise.all([
      session.page.waitForLoadState("domcontentloaded").catch(() => {}),
      locator.click(),
    ]);

    const resultingUrl = session.page.url();
    const title = sanitizeUntrustedText(await session.page.title(), { maxLength: 300 });

    const payload = {
      resultingUrl,
      title,
      contentWarning: UNTRUSTED_CONTENT_WARNING,
    };

    annotateWithInjectionSignals(payload, title);

    if (payload.injectionSignalsDetected) {
      await logEvent({
        action: "prompt_injection_signal_detected",
        url: resultingUrl,
        signals: payload.injectionSignalsDetected,
      });
    }

    return payload;
  } finally {
    await session.close();
  }
}
