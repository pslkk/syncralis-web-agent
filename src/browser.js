import { chromium } from "playwright";
import { config } from "./config.js";
import { assertSafeTarget, installSsrfGuard } from "./security/ssrf.js";
import { isAllowedByRobots } from "./security/robots.js";
import { acquireSlot } from "./security/rateLimiter.js";
import { assertClosed, recordSuccess, recordFailure } from "./security/circuitBreaker.js";
import { logEvent } from "./security/auditLog.js";

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      proxy: config.HTTP_PROXY ? { server: config.HTTP_PROXY } : undefined,
    });
  }
  return browserPromise;
}

export async function safeGoto(page, url, options = {}) {
  assertClosed(url);
  await assertSafeTarget(url);

  const robots = await isAllowedByRobots(url);
  if (!robots.allowed) {
    await logEvent({ action: "navigation_blocked", url, reason: robots.reason });
    throw new Error(`Blocked by robots.txt: ${robots.reason}`);
  }

  await acquireSlot(url);

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.NAVIGATION_TIMEOUT_MS,
      ...options,
    });
    recordSuccess(url);
    await logEvent({ action: "navigation", url, status: response?.status() });
    return response;
  } catch (err) {
    recordFailure(url);
    await logEvent({ action: "navigation_failed", url, error: String(err?.message || err) });
    throw err;
  }
}

export async function newTaskSession({ userAgent } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  });

  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(20000);

  await installSsrfGuard(context);

  const page = await context.newPage();

  return {
    page,
    context,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

export async function shutdownBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}
