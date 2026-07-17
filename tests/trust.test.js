import test from "node:test";
import assert from "node:assert/strict";
import { scoreDomain } from "../src/trust.js";

test("HTTPS official domain scores high", () => {
  const r = scoreDomain("https://ferrari.com/models", { mentionedBrands: ["ferrari"] });
  assert.ok(r.score >= 80, `expected high score, got ${r.score}`);
  assert.equal(r.verdict, "high");
});

test("HTTP-only site is penalized", () => {
  const r = scoreDomain("http://example.com/page");
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes("https")));
});

test("typosquat of a known brand scores low", () => {
  const r = scoreDomain("https://ferarri-cars-store.com/download", {
    mentionedBrands: ["ferrari"],
  });
  assert.ok(r.score < 50, `expected low score for typosquat, got ${r.score}`);
});

test("gov domain gets a trust bonus", () => {
  const r = scoreDomain("https://www.nasa.gov/press-release");
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes("government")));
});

test("invalid URL scores zero", () => {
  const r = scoreDomain("not a url");
  assert.equal(r.score, 0);
});

test("multi-label suffix (.co.uk) allowlist entry is reachable on a subdomain", () => {
  const r = scoreDomain("https://www.bbc.co.uk/news/uk-12345");
  assert.equal(r.domain, "bbc.co.uk");
  assert.ok(
    r.reasons.some((x) => x.includes('"bbc.co.uk" is on the curated trusted list')),
    `expected curated-list match, got reasons: ${r.reasons.join("; ")}`
  );
  assert.ok(r.score >= 80, `expected high score, got ${r.score}`);
});

test("unrelated .co.uk domain is NOT conflated with an allowlisted .co.uk domain", () => {
  const r = scoreDomain("https://attacker.co.uk/phish");
  assert.equal(r.domain, "attacker.co.uk");
  assert.ok(
    !r.reasons.some((x) => x.includes("curated trusted list")),
    `expected no trusted-list match, got reasons: ${r.reasons.join("; ")}`
  );
});

test("multi-tenant hosting suffix (.github.io) resolves per-tenant, not to the shared suffix", () => {
  const r = scoreDomain("https://some-random-user.github.io/site/");
  assert.equal(r.domain, "some-random-user.github.io");
});

test("bare eTLD+1 domain (no subdomain) still resolves correctly", () => {
  const r = scoreDomain("https://ferrari.com/");
  assert.equal(r.domain, "ferrari.com");
});

test("IPv4-literal host does not get mangled by dot-splitting", () => {
  const r = scoreDomain("https://192.168.1.1/admin");
  assert.equal(r.domain, "192.168.1.1");
});
