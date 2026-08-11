import test from "node:test";
import assert from "node:assert/strict";
import { stageAction, confirmAction, listPending, rejectAction, peekAction } from "../src/confirmations.js";

test("staged action can be confirmed and runs exactly once", async () => {
  let calls = 0;
  const id = stageAction("test action", async () => {
    calls += 1;
    return "done";
  });

  const before = listPending();
  assert.ok(before.some((p) => p.id === id));

  const result = await confirmAction(id);
  assert.equal(result.ok, true);
  assert.equal(result.result, "done");
  assert.equal(calls, 1);

  const second = await confirmAction(id);
  assert.equal(second.ok, false);
});

test("unknown confirmation id fails gracefully", async () => {
  const result = await confirmAction("act_does_not_exist");
  assert.equal(result.ok, false);
  assert.match(result.error, /No pending action/);
});

test("rejectAction removes a staged action without running it", async () => {
  let ran = false;
  const id = stageAction("should not run", async () => {
    ran = true;
  });
  const removed = rejectAction(id);
  assert.equal(removed, true);
  assert.equal(ran, false);

  const result = await confirmAction(id);
  assert.equal(result.ok, false);
});

test("stageAction without meta defaults to an empty object (backward compatible)", () => {
  const id = stageAction("no meta here", async () => "x");
  assert.deepEqual(peekAction(id).meta, {});
});

test("stageAction stores optional meta, retrievable via peekAction without consuming it", async () => {
  const id = stageAction("download from example.com", async () => "done", {
    domain: "example.com",
    kind: "download",
  });

  const peeked = peekAction(id);
  assert.equal(peeked.description, "download from example.com");
  assert.deepEqual(peeked.meta, { domain: "example.com", kind: "download" });
  assert.equal(typeof peeked.ageSeconds, "number");

  // peeking must not consume the action
  const stillThere = peekAction(id);
  assert.ok(stillThere);

  const result = await confirmAction(id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.meta, { domain: "example.com", kind: "download" });
});

test("peekAction returns undefined for an unknown id", () => {
  assert.equal(peekAction("act_does_not_exist"), undefined);
});

test("confirmAction still returns meta on a run() failure", async () => {
  const id = stageAction("will throw", async () => {
    throw new Error("boom");
  }, { domain: "risky.example" });
  const result = await confirmAction(id);
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta, { domain: "risky.example" });
});
