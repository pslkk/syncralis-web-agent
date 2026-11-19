import test from "node:test";
import assert from "node:assert/strict";
import { trustMemoryPath, trustMemoryPathFor } from "../src/config.js";

test("trust memory is stored per client so approvals never cross clients", () => {
  const base = trustMemoryPath();
  assert.equal(trustMemoryPathFor("local"), base);
  assert.equal(trustMemoryPathFor(undefined), base);
  const a = trustMemoryPathFor("alice");
  const b = trustMemoryPathFor("bob");
  assert.notEqual(a, b);
  assert.notEqual(a, base);
  assert.match(a, /\.alice\.json$/);
});

test("owner names cannot escape the directory", () => {
  const p = trustMemoryPathFor("../../etc/passwd");
  assert.ok(!p.includes(".."), p);
});
