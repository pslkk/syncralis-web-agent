import test from "node:test";
import assert from "node:assert/strict";
import { parseTokens, authenticate, clientIp } from "../src/http/auth.js";

const T1 = "a".repeat(32);
const T2 = "B".repeat(40);

test("parseTokens accepts bare and named tokens, lowercases names", () => {
  const bare = parseTokens(T1);
  assert.equal(bare[0].name, "default");
  const named = parseTokens(`Alice:${T1}, bob:${T2}`);
  assert.deepEqual(named.map((c) => c.name), ["alice", "bob"]);
});

test("parseTokens rejects weak, malformed, and duplicate input", () => {
  assert.throws(() => parseTokens(""), /no auth tokens/);
  assert.throws(() => parseTokens(undefined), /no auth tokens/);
  assert.throws(() => parseTokens("short"), /32-256/);
  assert.throws(() => parseTokens(`bad name:${T1}`), /invalid client name/);
  assert.throws(() => parseTokens(`a:${T1},a:${T2}`), /duplicate client name/);
  assert.throws(() => parseTokens(`a:${T1},b:${T1}`), /duplicate token/);
  assert.throws(() => parseTokens(`a:${"x y".repeat(20)}`), /32-256/);
});

test("authenticate matches the right client and rejects everything else", () => {
  const clients = parseTokens(`alice:${T1},bob:${T2}`);
  assert.equal(authenticate(`Bearer ${T1}`, clients), "alice");
  assert.equal(authenticate(`Bearer ${T2}`, clients), "bob");
  assert.equal(authenticate(`Bearer ${T1}x`, clients), null);
  assert.equal(authenticate(T1, clients), null, "scheme required");
  assert.equal(authenticate(`bearer ${T1}`, clients), null, "scheme is case-sensitive here");
  assert.equal(authenticate("Bearer ", clients), null);
  assert.equal(authenticate(undefined, clients), null);
  assert.equal(authenticate(`Bearer ${T1} extra`, clients), null);
});

test("clientIp ignores client-supplied left-hand X-Forwarded-For entries", () => {
  const req = (xff, remote = "10.0.0.1") => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: remote } });
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.9"), 1), "203.0.113.9");
  assert.equal(clientIp(req("203.0.113.9"), 1), "203.0.113.9");
  assert.equal(clientIp(req("1.1.1.1, 2.2.2.2, 3.3.3.3"), 2), "2.2.2.2");
  assert.equal(clientIp(req("6.6.6.6"), 0), "10.0.0.1");
  assert.equal(clientIp(req(undefined), 1), "10.0.0.1");
});
