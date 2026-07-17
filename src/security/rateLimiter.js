import { config } from "../config.js";

const buckets = new Map(); // domain -> { tokens, lastRefill }
const IDLE_EVICTION_MS = 30 * 60 * 1000;
let sweepTimer = null;
function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [domain, bucket] of buckets) {
      if (now - bucket.lastRefill > IDLE_EVICTION_MS) buckets.delete(domain);
    }
  }, IDLE_EVICTION_MS);
  sweepTimer.unref?.();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

export async function acquireSlot(url, { maxWaitMs = 15000 } = {}) {
  ensureSweeper();
  const domain = domainOf(url);
  const perMin = config.RATE_LIMIT_PER_DOMAIN_PER_MIN;
  const refillIntervalMs = 60000 / perMin;

  let bucket = buckets.get(domain);
  if (!bucket) {
    bucket = { tokens: perMin, lastRefill: Date.now() };
    buckets.set(domain, bucket);
  }

  const start = Date.now();
  while (true) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / refillIntervalMs);
    if (refill > 0) {
      bucket.tokens = Math.min(perMin, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return;
    }
    if (now - start > maxWaitMs) {
      throw new Error(
        `Rate limit exceeded for domain "${domain}" (${perMin}/min) and wait time exhausted`
      );
    }
    await new Promise((r) => setTimeout(r, Math.min(500, refillIntervalMs)));
  }
}
