import { config } from "../config.js";

const state = new Map(); // domain -> { failures, openedAt, lastSeenAt }

let sweepTimer = null;
function ensureSweeper() {
  if (sweepTimer) return;
  const interval = Math.max(config.CIRCUIT_BREAKER_COOLDOWN_MS * 2, 5 * 60 * 1000);
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [domain, entry] of state) {
      if (now - (entry.lastSeenAt || 0) > interval) state.delete(domain);
    }
  }, interval);
  sweepTimer.unref?.();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

export function assertClosed(url) {
  ensureSweeper();
  const domain = domainOf(url);
  const entry = state.get(domain);
  if (!entry || entry.openedAt === null) return;

  const elapsed = Date.now() - entry.openedAt;
  if (elapsed < config.CIRCUIT_BREAKER_COOLDOWN_MS) {
    const remainingSec = Math.ceil((config.CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000);
    throw new Error(
      `Circuit breaker open for "${domain}" after repeated failures — retry in ~${remainingSec}s`
    );
  }
  entry.openedAt = null;
  entry.failures = 0;
  entry.lastSeenAt = Date.now();
}

export function recordSuccess(url) {
  const domain = domainOf(url);
  state.set(domain, { failures: 0, openedAt: null, lastSeenAt: Date.now() });
}

export function recordFailure(url) {
  const domain = domainOf(url);
  const entry = state.get(domain) || { failures: 0, openedAt: null };
  entry.failures += 1;
  entry.lastSeenAt = Date.now();
  if (entry.failures >= config.CIRCUIT_BREAKER_FAILURE_THRESHOLD && !entry.openedAt) {
    entry.openedAt = Date.now();
  }
  state.set(domain, entry);
}
