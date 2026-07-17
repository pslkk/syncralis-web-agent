import { newTaskSession, safeGoto } from "../browser.js";
import { assertSafeTarget } from "../security/ssrf.js";
import { isAllowedByRobots } from "../security/robots.js";
import { acquireSlot } from "../security/rateLimiter.js";
import { assertClosed, recordSuccess, recordFailure } from "../security/circuitBreaker.js";
import { logEvent } from "../security/auditLog.js";
import { handleDownload } from "../quarantine.js";
import { textLocator } from "./textLocator.js";

async function gotoForDirectDownload(page, directUrl) {
  assertClosed(directUrl);
  await assertSafeTarget(directUrl);

  const robots = await isAllowedByRobots(directUrl);
  if (!robots.allowed) {
    await logEvent({ action: "navigation_blocked", url: directUrl, reason: robots.reason });
    throw new Error(`Blocked by robots.txt: ${robots.reason}`);
  }

  await acquireSlot(directUrl);
  return page.goto(directUrl, { waitUntil: "domcontentloaded" });
}

export async function downloadFile({ url, matchText, selector, directUrl }) {
  const session = await newTaskSession();
  try {
    if (directUrl) {
      let navigationError = null;
      let download;
      try {
        [download] = await Promise.all([
          session.page.waitForEvent("download", { timeout: 20000 }),
          gotoForDirectDownload(session.page, directUrl).catch((err) => {
            navigationError = err;
          }),
        ]);
      } catch (err) {
        recordFailure(directUrl);
        await logEvent({
          action: "navigation_failed",
          url: directUrl,
          error: String((navigationError || err)?.message || navigationError || err),
        });
        throw navigationError || err;
      }

      recordSuccess(directUrl);
      await logEvent({ action: "navigation", url: directUrl, status: "download_started" });

      const report = await handleDownload(download);
      return { sourceUrl: directUrl, ...report };
    }

    await safeGoto(session.page, url);

    let locator;
    if (selector) {
      locator = session.page.locator(selector).first();
    } else if (matchText) {
      locator = textLocator(session.page, matchText);
    } else {
      throw new Error("Provide matchText, selector, or directUrl");
    }

    await locator.waitFor({ state: "visible", timeout: 10000 });
    const [download] = await Promise.all([
      session.page.waitForEvent("download", { timeout: 20000 }),
      locator.click(),
    ]);

    const report = await handleDownload(download);
    return { sourceUrl: url, ...report };
  } finally {
    await session.close();
  }
}
