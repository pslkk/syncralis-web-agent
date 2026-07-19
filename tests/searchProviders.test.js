import test from "node:test";
import assert from "node:assert/strict";

process.env.SYNCRALIS_WEB_AGENT_TAVILY_API_KEY = "test-tavily-key";
process.env.SYNCRALIS_WEB_AGENT_BRAVE_API_KEY = "test-brave-key";
process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_PROVIDER = "auto";
process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_MAX_RETRIES = "2";
process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_TIMEOUT_MS = "5000";

const { searchTavily, TAVILY_ENDPOINT } = await import("../src/tools/searchProviders/tavily.js");
const { searchBrave, BRAVE_ENDPOINT } = await import("../src/tools/searchProviders/brave.js");
const { SearchProviderError } = await import("../src/tools/searchProviders/errors.js");
const { runWebSearch } = await import("../src/tools/searchProviders/index.js");
const { webSearch } = await import("../src/tools/search.js");

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("searchTavily parses and normalizes a successful response", async () => {
  await withMockedFetch(
    async (url, opts) => {
      assert.equal(url, TAVILY_ENDPOINT);
      assert.equal(opts.headers.Authorization, "Bearer abc123");
      const body = JSON.parse(opts.body);
      assert.equal(body.query, "test query");
      return jsonResponse(200, {
        results: [
          { title: "Result One", url: "https://example.com/1", content: "Snippet one", published_date: "2026-01-01" },
          { title: "Result Two", url: "https://example.org/2", content: "Snippet two" },
        ],
      });
    },
    async () => {
      const results = await searchTavily({ apiKey: "abc123", query: "test query", maxResults: 8, timeoutMs: 5000 });
      assert.equal(results.length, 2);
      assert.equal(results[0].href, "https://example.com/1");
      assert.equal(results[0].publishedDate, "2026-01-01");
      assert.equal(results[1].publishedDate, undefined);
    }
  );
});

test("searchTavily classifies 401 as an auth error", async () => {
  await withMockedFetch(
    async () => jsonResponse(401, { error: "invalid key" }),
    async () => {
      await assert.rejects(
        () => searchTavily({ apiKey: "bad", query: "q", maxResults: 5, timeoutMs: 5000 }),
        (err) => {
          assert.ok(err instanceof SearchProviderError);
          assert.equal(err.kind, "auth");
          return true;
        }
      );
    }
  );
});

test("searchTavily classifies 429 as rate_limit and captures Retry-After", async () => {
  await withMockedFetch(
    async () => jsonResponse(429, { error: "slow down" }, { "retry-after": "2" }),
    async () => {
      await assert.rejects(
        () => searchTavily({ apiKey: "abc", query: "q", maxResults: 5, timeoutMs: 5000 }),
        (err) => {
          assert.equal(err.kind, "rate_limit");
          assert.equal(err.retryAfterMs, 2000);
          return true;
        }
      );
    }
  );
});

test("searchBrave sends the subscription token header and parses web.results", async () => {
  await withMockedFetch(
    async (url, opts) => {
      assert.ok(String(url).startsWith(BRAVE_ENDPOINT));
      assert.equal(opts.headers["X-Subscription-Token"], "brave-key");
      return jsonResponse(200, {
        web: { results: [{ title: "Brave Result", url: "https://example.net/x", description: "desc" }] },
      });
    },
    async () => {
      const results = await searchBrave({
        apiKey: "brave-key",
        query: "q",
        maxResults: 5,
        safeSearch: "moderate",
        timeoutMs: 5000,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].href, "https://example.net/x");
      assert.equal(results[0].snippet, "desc");
    }
  );
});

test("runWebSearch retries a transient 500 then succeeds, without exhausting the budget", async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, { results: [{ title: "OK", url: "https://example.com/ok", content: "" }] });
    },
    async () => {
      const outcome = await runWebSearch({ query: "q", maxResults: 5, safeSearch: "moderate", timeoutMs: 5000 });
      assert.equal(outcome.provider, "tavily");
      assert.equal(outcome.results.length, 1);
      assert.equal(calls, 2, "expected exactly one retry before success");
    }
  );
});

test("runWebSearch fails over from Tavily to Brave when Tavily rejects the key", async () => {
  await withMockedFetch(
    async (url) => {
      if (String(url).startsWith(TAVILY_ENDPOINT)) return jsonResponse(401, { error: "bad key" });
      return jsonResponse(200, {
        web: { results: [{ title: "Fallback", url: "https://example.com/fallback", description: "" }] },
      });
    },
    async () => {
      const outcome = await runWebSearch({ query: "q", maxResults: 5, safeSearch: "moderate", timeoutMs: 5000 });
      assert.equal(outcome.provider, "brave");
      assert.equal(outcome.attempts[0].provider, "tavily");
      assert.equal(outcome.attempts[0].ok, false);
    }
  );
});

test("webSearch sanitizes titles, attaches trust scores, and reports the provider used", async () => {
  await withMockedFetch(
    async () =>
      jsonResponse(200, {
        results: [
          { title: "Wikipedia\u200B page", url: "https://wikipedia.org/wiki/Test", content: "some content" },
        ],
      }),
    async () => {
      const payload = await webSearch({ query: "test", maxResults: 5 });
      assert.equal(payload.provider, "tavily");
      assert.equal(payload.results.length, 1);
      assert.ok(!/[\u200B]/.test(payload.results[0].title));
      assert.ok(payload.results[0].trust.score >= 80);
      assert.equal(payload.contentWarning.length > 0, true);
    }
  );
});
