import test from "node:test";
import assert from "node:assert/strict";
import { scoreDomain } from "../src/trust.js";

test("HTTPS official domain scores high", async () => {
  const result = await scoreDomain("https://ferrari.com/models", { mentionedBrands: ["ferrari"] });
  assert.ok(result.score >= 80, `expected high score, got ${result.score}`);
  assert.equal(result.verdict, "high");
});

test("HTTP-only site is penalized", async () => {
  const result = await scoreDomain("http://example.com/page");
  assert.ok(result.reasons.some((reason) => reason.toLowerCase().includes("https")));
});

test("typosquat of a known brand scores low", async () => {
  const result = await scoreDomain("https://ferarri-cars-store.com/download", {
    mentionedBrands: ["ferrari"],
  });
  assert.ok(result.score < 50, `expected low score for typosquat, got ${result.score}`);
});

test("typosquat of a known brand is hard-flagged (local trust memory can never override it)", async () => {
  const result = await scoreDomain("https://ferarri-cars-store.com/download", {
    mentionedBrands: ["ferrari"],
  });
  assert.equal(result.hardFlag, true);
});

test("gov domain gets a trust bonus", async () => {
  const result = await scoreDomain("https://www.nasa.gov/press-release");
  assert.ok(result.reasons.some((reason) => reason.toLowerCase().includes("government")));
});

test("invalid URL scores zero and is hard-flagged", async () => {
  const result = await scoreDomain("not a url");
  assert.equal(result.score, 0);
  assert.equal(result.hardFlag, true);
});

test("multi-label suffix (.co.uk) allowlist entry is reachable on a subdomain", async () => {
  const result = await scoreDomain("https://www.bbc.co.uk/news/uk-12345");
  assert.equal(result.domain, "bbc.co.uk");
  assert.ok(
    result.reasons.some((reason) => reason.includes('"bbc.co.uk" is on the curated trusted list')),
    `expected curated-list match, got reasons: ${result.reasons.join("; ")}`
  );
  assert.ok(result.score >= 80, `expected high score, got ${result.score}`);
});

test("unrelated .co.uk domain is NOT conflated with an allowlisted .co.uk domain", async () => {
  const result = await scoreDomain("https://attacker.co.uk/phish");
  assert.equal(result.domain, "attacker.co.uk");
  assert.ok(
    !result.reasons.some((reason) => reason.includes("curated trusted list")),
    `expected no trusted-list match, got reasons: ${result.reasons.join("; ")}`
  );
});

test("multi-tenant hosting suffix (.github.io) resolves per-tenant, not to the shared suffix", async () => {
  const result = await scoreDomain("https://some-random-user.github.io/site/");
  assert.equal(result.domain, "some-random-user.github.io");
});

test("bare eTLD+1 domain (no subdomain) still resolves correctly", async () => {
  const result = await scoreDomain("https://ferrari.com/");
  assert.equal(result.domain, "ferrari.com");
});

test("IPv4-literal host does not get mangled by dot-splitting", async () => {
  const result = await scoreDomain("https://192.168.1.1/admin");
  assert.equal(result.domain, "192.168.1.1");
});

test("a domain with no local trust memory history is unaffected by the memory feature", async () => {
  const result = await scoreDomain("https://never-seen-before-domain-xyz123.example/");
  assert.equal(typeof result.score, "number");
  assert.ok(!result.reasons.some((reason) => reason.includes("local trust memory")));
});
