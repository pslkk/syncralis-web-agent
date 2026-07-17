import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { assertSafeTarget } from "../src/security/ssrf.js";

function stubLookup(t, impl) {
  t.mock.method(dns, "lookup", impl);
}

test("blocks loopback IP", async () => {
  await assert.rejects(() => assertSafeTarget("http://127.0.0.1/admin"));
});

test("blocks private 10.x range", async () => {
  await assert.rejects(() => assertSafeTarget("http://10.1.2.3/"));
});

test("blocks cloud metadata address", async () => {
  await assert.rejects(() => assertSafeTarget("http://169.254.169.254/latest/meta-data"));
});

test("blocks localhost hostname", async () => {
  await assert.rejects(() => assertSafeTarget("http://localhost:8080/"));
});

test("blocks non-http(s) protocols", async () => {
  await assert.rejects(() => assertSafeTarget("file:///etc/passwd"));
});

test("allows a normal public https URL (mocked DNS)", async (t) => {
  stubLookup(t, async () => [{ address: "93.184.216.34", family: 4 }]);
  await assert.doesNotReject(() => assertSafeTarget("https://example.com/"));
});

test("blocks a hostname that resolves to a private address (mocked DNS)", async (t) => {
  stubLookup(t, async () => [{ address: "10.0.0.5", family: 4 }]);
  await assert.rejects(() => assertSafeTarget("https://sneaky.example/"));
});

test("fails closed when DNS resolution errors (was fail-open before this pass)", async (t) => {
  stubLookup(t, async () => {
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  });
  await assert.rejects(() => assertSafeTarget("https://flaky-resolver.example/"));
});

test("blocks bracketed IPv6 loopback", async () => {
  await assert.rejects(() => assertSafeTarget("http://[::1]/"));
});

test("blocks IPv4-mapped IPv6 loopback", async () => {
  await assert.rejects(() => assertSafeTarget("http://[::ffff:127.0.0.1]/"));
});

test("blocks IPv4-mapped IPv6 metadata address", async () => {
  await assert.rejects(() => assertSafeTarget("http://[::ffff:169.254.169.254]/"));
});

test("blocks link-local IPv6", async () => {
  await assert.rejects(() => assertSafeTarget("http://[fe80::1]/"));
});

test("blocks unique-local IPv6", async () => {
  await assert.rejects(() => assertSafeTarget("http://[fd00::1]/"));
});

test("blocks IPv6 multicast", async () => {
  await assert.rejects(() => assertSafeTarget("http://[ff02::1]/"));
});

test("blocks 6to4-tunneled loopback (2002:7f00:1::)", async () => {
  await assert.rejects(() => assertSafeTarget("http://[2002:7f00:0001::]/"));
});

test("blocks Teredo-tunneled loopback", async () => {
  await assert.rejects(() => assertSafeTarget("http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/"));
});

test("blocks decimal-encoded loopback IPv4", async () => {
  await assert.rejects(() => assertSafeTarget("http://2130706433/"));
});

test("blocks octal-encoded loopback IPv4", async () => {
  await assert.rejects(() => assertSafeTarget("http://017700000001/"));
});

test("blocks CGNAT range", async () => {
  await assert.rejects(() => assertSafeTarget("http://100.64.0.1/"));
});
