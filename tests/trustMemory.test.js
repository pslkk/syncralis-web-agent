import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluatePromotion,
  recordDecision,
  getMemoryEntry,
  _resetCacheForTests,
} from "../src/trustMemory.js";

const OPTS = { minConfirmations: 5, maxAgeDays: 90, rejectionCooldownDays: 30 };

function freshStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "trustmemory-test-"));
  return { dir, storePath: path.join(dir, "trust-memory.json") };
}

test("evaluatePromotion: no entry (never seen) is never promoted", () => {
  const result = evaluatePromotion(undefined, OPTS);
  assert.equal(result.promoted, false);
});

test("evaluatePromotion: below minimum confirmation count is not promoted", () => {
  const entry = { confirmedCount: 4, rejectedCount: 0, lastConfirmedAt: new Date().toISOString() };
  const result = evaluatePromotion(entry, OPTS);
  assert.equal(result.promoted, false);
});

test("evaluatePromotion: meeting the confirmation threshold with a recent confirmation IS promoted", () => {
  const entry = { confirmedCount: 5, rejectedCount: 0, lastConfirmedAt: new Date().toISOString() };
  const result = evaluatePromotion(entry, OPTS);
  assert.equal(result.promoted, true);
  assert.match(result.reason, /5 prior explicit user confirmations/);
});

test("evaluatePromotion: exceeding the threshold is also promoted", () => {
  const entry = { confirmedCount: 40, rejectedCount: 0, lastConfirmedAt: new Date().toISOString() };
  assert.equal(evaluatePromotion(entry, OPTS).promoted, true);
});

test("evaluatePromotion: stale confirmation (older than maxAgeDays) is NOT promoted", () => {
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days ago
  const entry = { confirmedCount: 10, rejectedCount: 0, lastConfirmedAt: old };
  const result = evaluatePromotion(entry, OPTS);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /expired/);
});

test("evaluatePromotion: ANY rejection within the cooldown window blocks promotion, even with high confirm count", () => {
  const entry = {
    confirmedCount: 50,
    rejectedCount: 1,
    lastConfirmedAt: new Date().toISOString(),
    lastRejectedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
  };
  const result = evaluatePromotion(entry, OPTS);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /cooldown/);
});

test("evaluatePromotion: rejection outside the cooldown window no longer blocks promotion", () => {
  const entry = {
    confirmedCount: 10,
    rejectedCount: 1,
    lastConfirmedAt: new Date().toISOString(),
    lastRejectedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(), // 200 days ago
  };
  const result = evaluatePromotion(entry, OPTS);
  assert.equal(result.promoted, true);
});

test("recordDecision + getMemoryEntry: confirmations accumulate and persist across reads", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  try {
    for (let i = 0; i < 3; i++) {
      await recordDecision(storePath, "example.com", "confirmed");
    }
    const entry = await getMemoryEntry(storePath, "example.com");
    assert.equal(entry.confirmedCount, 3);
    assert.equal(entry.rejectedCount, 0);
    assert.ok(entry.lastConfirmedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});

test("recordDecision: a rejection resets confirmedCount to zero and records rejectedCount", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  try {
    for (let i = 0; i < 5; i++) await recordDecision(storePath, "risky.example", "confirmed");
    let entry = await getMemoryEntry(storePath, "risky.example");
    assert.equal(entry.confirmedCount, 5);

    await recordDecision(storePath, "risky.example", "rejected");
    entry = await getMemoryEntry(storePath, "risky.example");
    assert.equal(entry.confirmedCount, 0);
    assert.equal(entry.rejectedCount, 1);
    assert.ok(entry.lastRejectedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});

test("recordDecision: concurrent confirmations for the same domain are serialized without loss", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  try {
    await Promise.all(
      Array.from({ length: 20 }, () => recordDecision(storePath, "concurrent.example", "confirmed"))
    );
    const entry = await getMemoryEntry(storePath, "concurrent.example");
    assert.equal(entry.confirmedCount, 20, "all 20 concurrent confirmations should be counted, none lost to a race");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});

test("getMemoryEntry: unseen domain returns undefined rather than throwing", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  try {
    const entry = await getMemoryEntry(storePath, "never-seen.example");
    assert.equal(entry, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});

test("getMemoryEntry: a corrupted store file fails open to 'no memory' instead of throwing", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, "{ this is not valid json");
    const entry = await getMemoryEntry(storePath, "example.com");
    assert.equal(entry, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});

test("end-to-end: a domain only promotes after enough confirmations, feeding evaluatePromotion real persisted data", async () => {
  const { dir, storePath } = freshStorePath();
  _resetCacheForTests();
  try {
    for (let i = 0; i < 4; i++) await recordDecision(storePath, "medium-trust.example", "confirmed");
    let entry = await getMemoryEntry(storePath, "medium-trust.example");
    assert.equal(evaluatePromotion(entry, OPTS).promoted, false);

    await recordDecision(storePath, "medium-trust.example", "confirmed"); // 5th confirmation
    entry = await getMemoryEntry(storePath, "medium-trust.example");
    assert.equal(evaluatePromotion(entry, OPTS).promoted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    _resetCacheForTests();
  }
});
