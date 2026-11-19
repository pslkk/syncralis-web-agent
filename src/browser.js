import { chromium } from "playwright";
import { config, webBotAuthKeypair } from "./config.js";
import { assertSafeTarget, installSsrfGuard } from "./security/ssrf.js";
import { isAllowedByRobots } from "./security/robots.js";
import { acquireSlot } from "./security/rateLimiter.js";
import { assertClosed, recordSuccess, recordFailure } from "./security/circuitBreaker.js";
import { logEvent } from "./security/auditLog.js";
import { signRequest } from "./security/webBotAuth.js";
import { Semaphore } from "./runtime/limits.js";
import { startGuardProxy } from "./security/guardProxy.js";
import { resolveSafeHost } from "./security/ssrf.js";

async function installWebBotAuthSigning(context, keypair) {
  if (!keypair) return;

  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const signatureHeaders = signRequest({
        method: request.method(),
        url: request.url(),
        keyid: keypair.keyid,
        privateKeyPem: keypair.privateKeyPem,
        agentDirectoryUrl: keypair.agentDirectoryUrl,
      });
      await route.fallback({ headers: { ...request.headers(), ...signatureHeaders } });
    } catch (err) {
      await logEvent({
        action: "web_bot_auth_signing_failed",
        url: request.url(),
        error: String(err?.message || err),
      }).catch(() => {});
      await route.fallback();
    }
  });
}

let browserPromise = null;

// Global cap on simultaneously open browser contexts (memory is the scarce resource).
// Unlimited by default (original stdio behaviour); the HTTP server sets a cap at startup.
let browserSlots = new Semaphore(1_000_000, { maxQueue: 1_000_000 });
export function setBrowserConcurrency(n) {
  browserSlots = new Semaphore(n, { maxQueue: 32 });
}

let guardProxyPromise = null;

// Chromium is forced through a loopback proxy that resolves and validates each hostname once and
// dials the validated IP (see security/guardProxy.js). This closes the DNS-rebinding window that a
// check-then-navigate guard leaves open. It cannot be combined with an upstream HTTP_PROXY (that
// proxy would do the DNS), so in that case only the per-request route guard applies.
async function egressProxyOptions() {
  if (config.HTTP_PROXY) {
    if (config.SSRF_PINNED_PROXY) {
      logEvent({ action: "ssrf_dns_pinning_unavailable", reason: "HTTP_PROXY is configured" }).catch(() => {});
    }
    return { server: config.HTTP_PROXY };
  }
  if (config.ALLOW_PRIVATE_NETWORK_TARGETS || !config.SSRF_PINNED_PROXY) return undefined;
  if (!guardProxyPromise) {
    guardProxyPromise = startGuardProxy({
      resolveHost: resolveSafeHost,
      log: (entry) => logEvent({ action: entry.msg, host: entry.host, reason: entry.reason }).catch(() => {}),
    });
    guardProxyPromise.catch(() => {
      guardProxyPromise = null;
    });
  }
  const proxy = await guardProxyPromise;
  // "<-loopback>" makes Chromium send localhost/127.0.0.1 through the proxy too (where it is refused).
  return { server: proxy.url, username: proxy.username, password: proxy.password, bypass: "<-loopback>" };
}

function launchBrowser() {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (config.CHROMIUM_DISABLE_DEV_SHM) args.push("--disable-dev-shm-usage");
  // Only for containers where the container itself is the isolation boundary.
  if (config.CHROMIUM_NO_SANDBOX) args.push("--no-sandbox");
  if (config.CHROMIUM_LOW_MEMORY) {
    args.push(
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--renderer-process-limit=1",
      "--js-flags=--max-old-space-size=192"
    );
  }

  const p = egressProxyOptions()
    .then((proxy) => chromium.launch({ headless: true, args, proxy }))
    .then((browser) => {
      // If Chromium crashes or is killed (e.g. OOM), forget it so the next task relaunches it.
      browser.on("disconnected", () => {
        if (browserPromise === p) browserPromise = null;
        logEvent({ action: "browser_disconnected" }).catch(() => {});
      });
      return browser;
    });
  p.catch(() => {
    if (browserPromise === p) browserPromise = null;
  });
  return p;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launchBrowser();
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
  const release = await browserSlots.acquire({ timeoutMs: config.BROWSER_QUEUE_TIMEOUT_MS });
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        userAgent ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      acceptDownloads: true,
    });

    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(20000);

    await installSsrfGuard(context);
    await installWebBotAuthSigning(context, webBotAuthKeypair);

    const page = await context.newPage();

    return {
      page,
      context,
      close: async () => {
        await context.close().catch(() => {});
        release();
      },
    };
  } catch (err) {
    await context?.close().catch(() => {});
    release();
    throw err;
  }
}

export async function shutdownBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    const browser = await p.catch(() => null);
    await browser?.close().catch(() => {});
  }
  const gp = guardProxyPromise;
  guardProxyPromise = null;
  if (gp) (await gp.catch(() => null))?.close();
}
