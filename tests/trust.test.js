import test from "node:test";
import assert from "node:assert/strict";
import { scoreDomain } from "../src/trust.js";

test("HTTPS official domain scores high", async () => {
  const r = await scoreDomain("https://ferrari.com/models", { mentionedBrands: ["ferrari"] });
  assert.ok(r.score >= 80, `expected high score, got ${r.score}`);
  assert.equal(r.verdict, "high");
});

test("HTTP-only site is penalized", async () => {
  const r = await scoreDomain("http://example.com/page");
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes("https")));
});

test("typosquat of a known brand scores low", async () => {
  const r = await scoreDomain("https://ferarri-cars-store.com/download", {
    mentionedBrands: ["ferrari"],
  });
  assert.ok(r.score < 50, `expected low score for typosquat, got ${r.score}`);
});

test("typosquat of a known brand is hard-flagged (local trust memory can never override it)", async () => {
  const r = await scoreDomain("https://ferarri-cars-store.com/download", {
    mentionedBrands: ["ferrari"],
  });
  assert.equal(r.hardFlag, true);
});

test("gov domain gets a trust bonus", async () => {
  const r = await scoreDomain("https://www.nasa.gov/press-release");
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes("government")));
});

test("invalid URL scores zero and is hard-flagged", async () => {
  const r = await scoreDomain("not a url");
  assert.equal(r.score, 0);
  assert.equal(r.hardFlag, true);
});

test("multi-label suffix (.co.uk) allowlist entry is reachable on a subdomain", async () => {
  const r = await scoreDomain("https://www.bbc.co.uk/news/uk-12345");
  assert.equal(r.domain, "bbc.co.uk");
  assert.ok(
    r.reasons.some((x) => x.includes('"bbc.co.uk" is on the curated trusted list')),
    `expected curated-list match, got reasons: ${r.reasons.join("; ")}`
  );
  assert.ok(r.score >= 80, `expected high score, got ${r.score}`);
});

test("unrelated .co.uk domain is NOT conflated with an allowlisted .co.uk domain", async () => {
  const r = await scoreDomain("https://attacker.co.uk/phish");
  assert.equal(r.domain, "attacker.co.uk");
  assert.ok(
    !r.reasons.some((x) => x.includes("curated trusted list")),
    `expected no trusted-list match, got reasons: ${r.reasons.join("; ")}`
  );
});

test("multi-tenant hosting suffix (.github.io) resolves per-tenant, not to the shared suffix", async () => {
  const r = await scoreDomain("https://some-random-user.github.io/site/");
  assert.equal(r.domain, "some-random-user.github.io");
});

test("bare eTLD+1 domain (no subdomain) still resolves correctly", async () => {
  const r = await scoreDomain("https://ferrari.com/");
  assert.equal(r.domain, "ferrari.com");
});

test("IPv4-literal host does not get mangled by dot-splitting", async () => {
  const r = await scoreDomain("https://192.168.1.1/admin");
  assert.equal(r.domain, "192.168.1.1");
});

test("a domain with no local trust memory history is unaffected by the memory feature", async () => {
  const r = await scoreDomain("https://never-seen-before-domain-xyz123.example/");
  assert.equal(typeof r.score, "number");
  assert.ok(!r.reasons.some((x) => x.includes("local trust memory")));
});
