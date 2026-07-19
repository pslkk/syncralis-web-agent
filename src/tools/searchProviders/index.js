import { config } from "../../config.js";
import { searchTavily, TAVILY_ENDPOINT } from "./tavily.js";
import { searchBrave, BRAVE_ENDPOINT } from "./brave.js";
import { searchLegacyBrowser, LEGACY_BROWSER_ENDPOINT } from "./legacyBrowser.js";
import { SearchProviderError } from "./errors.js";
import { acquireSlot } from "../../security/rateLimiter.js";
import { assertClosed, recordSuccess, recordFailure } from "../../security/circuitBreaker.js";

const PROVIDERS = {
  tavily: {
    name: "tavily",
    endpoint: TAVILY_ENDPOINT,
    hasKey: () => Boolean(config.TAVILY_API_KEY),
    run: (args) => searchTavily({ apiKey: config.TAVILY_API_KEY, ...args }),
  },
  brave: {
    name: "brave",
    endpoint: BRAVE_ENDPOINT,
    hasKey: () => Boolean(config.BRAVE_API_KEY),
    run: (args) => searchBrave({ apiKey: config.BRAVE_API_KEY, ...args }),
  },
  legacy_browser_ddg: {
    name: "legacy_browser_ddg",
    endpoint: LEGACY_BROWSER_ENDPOINT,
    hasKey: () => config.ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK,
    run: (args) => searchLegacyBrowser(args),
  },
};

function resolveProviderOrder() {
  const preferred = config.WEB_SEARCH_PROVIDER;
  const order = [];

  if (preferred === "tavily") {
    order.push(PROVIDERS.tavily);
  } else if (preferred === "brave") {
    order.push(PROVIDERS.brave);
  } else {
    if (PROVIDERS.tavily.hasKey()) order.push(PROVIDERS.tavily);
    if (PROVIDERS.brave.hasKey()) order.push(PROVIDERS.brave);
  }

  if (PROVIDERS.legacy_browser_ddg.hasKey()) order.push(PROVIDERS.legacy_browser_ddg);

  return order.filter((p) => p.hasKey());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  return err instanceof SearchProviderError && ["rate_limit", "server", "network", "timeout"].includes(err.kind);
}

async function runProviderWithResilience(provider, args) {
  assertClosed(provider.endpoint);
  await acquireSlot(provider.endpoint);

  const maxRetries = config.WEB_SEARCH_MAX_RETRIES;
  let attempt = 0;
  while (true) {
    try {
      const results = await provider.run(args);
      recordSuccess(provider.endpoint);
      return results;
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) {
        recordFailure(provider.endpoint);
        throw err;
      }
      const baseBackoff = Math.min(4000, 300 * 2 ** attempt);
      const backoff = err.retryAfterMs ?? baseBackoff;
      const jitter = Math.random() * 0.3 * backoff;
      await sleep(backoff + jitter);
      attempt += 1;
    }
  }
}

export async function runWebSearch({ query, maxResults, safeSearch, timeoutMs }) {
  const order = resolveProviderOrder();

  if (order.length === 0) {
    throw new Error(
      "No web search provider is configured. Set SYNCRALIS_WEB_AGENT_TAVILY_API_KEY and/or " +
        "SYNCRALIS_WEB_AGENT_BRAVE_API_KEY (get a key from tavily.com or brave.com/search/api), " +
        "or set SYNCRALIS_WEB_AGENT_ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK=true to use a degraded, " +
        "unauthenticated fallback that is likely to be blocked by anti-bot protection."
    );
  }

  const attempts = [];
  for (const provider of order) {
    const startedAt = Date.now();
    try {
      const results = await runProviderWithResilience(provider, { query, maxResults, safeSearch, timeoutMs });
      attempts.push({ provider: provider.name, ok: true, latencyMs: Date.now() - startedAt });
      return { provider: provider.name, results, attempts };
    } catch (err) {
      attempts.push({
        provider: provider.name,
        ok: false,
        latencyMs: Date.now() - startedAt,
        kind: err instanceof SearchProviderError ? err.kind : "unknown",
        status: err instanceof SearchProviderError ? err.status : undefined,
        message: String(err?.message || err),
      });
    }
  }

  const summary = attempts.map((a) => `${a.provider} (${a.kind || "error"}${a.status ? ` ${a.status}` : ""})`).join(", ");
  const err = new Error(`All configured web search providers failed: ${summary}`);
  err.attempts = attempts;
  throw err;
}
