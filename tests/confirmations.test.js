import test from "node:test";
import assert from "node:assert/strict";
import { stageAction, confirmAction, listPending, rejectAction } from "../src/confirmations.js";

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
