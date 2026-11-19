import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore, withTimeout, FixedWindowLimiter, BusyError } from "../src/runtime/limits.js";

test("semaphore never exceeds max and hands slots to waiters in order", async () => {
  const sem = new Semaphore(2, { maxQueue: 10 });
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.active, 2);

  const order = [];
  const p3 = sem.acquire().then((r) => (order.push(3), r));
  const p4 = sem.acquire().then((r) => (order.push(4), r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sem.queued, 2);

  r1();
  const r3 = await p3;
  assert.equal(sem.active, 2);
  assert.equal(sem.queued, 1);
  r2();
  const r4 = await p4;
  assert.deepEqual(order, [3, 4]);
  r3();
  r4();
  assert.equal(sem.active, 0);
});

test("release is idempotent", async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.active, 0);
  const again = await sem.acquire();
  assert.equal(sem.active, 1);
  again();
});

test("acquire times out and removes itself from the queue", async () => {
  const sem = new Semaphore(1);
  const hold = await sem.acquire();
  await assert.rejects(sem.acquire({ timeoutMs: 20 }), (e) => e instanceof BusyError);
  assert.equal(sem.queued, 0);
  hold();
  assert.equal(sem.active, 0);
});

test("acquire rejects immediately when the queue is full", async () => {
  const sem = new Semaphore(1, { maxQueue: 1 });
  const hold = await sem.acquire();
  const waiting = sem.acquire({ timeoutMs: 1000 });
  await assert.rejects(sem.acquire({ timeoutMs: 1000 }), BusyError);
  hold();
  (await waiting)();
});

test("withTimeout resolves, rejects, and times out", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 100), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 100), /boom/);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "slow op"), (e) => e.code === "TIMEOUT" && /slow op/.test(e.message));
});

test("FixedWindowLimiter allows `limit` hits per window then blocks until reset", () => {
  let t = 1000;
  const lim = new FixedWindowLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.equal(lim.hit("a").allowed, true);
  assert.equal(lim.hit("a").allowed, true);
  assert.equal(lim.hit("a").allowed, true);
  const blocked = lim.hit("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
  assert.equal(lim.hit("b").allowed, true, "keys are independent");
  t += 1001;
  assert.equal(lim.hit("a").allowed, true, "window resets");
});

test("FixedWindowLimiter.isBlocked does not consume allowance", () => {
  let t = 0;
  const lim = new FixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(lim.isBlocked("k"), false);
  lim.hit("k");
  assert.equal(lim.isBlocked("k"), false);
  lim.hit("k");
  assert.equal(lim.isBlocked("k"), true);
  t += 1001;
  assert.equal(lim.isBlocked("k"), false);
});
