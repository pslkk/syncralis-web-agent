import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSizeLimiter, saveWithLimit, SizeLimitError } from "../src/security/sizeLimit.js";

const exists = (p) => access(p).then(() => true, () => false);

test("limiter passes data up to the cap and errors the moment it is exceeded", async () => {
  const chunks = [];
  await pipeline(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]), createSizeLimiter(10), async function* (src) {
    for await (const c of src) chunks.push(c);
  });
  assert.equal(Buffer.concat(chunks).length, 10);

  await assert.rejects(
    pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), createSizeLimiter(10), async function* (src) {
      for await (const _ of src);
    }),
    SizeLimitError
  );
});

test("saveWithLimit writes small downloads and removes oversized ones mid-transfer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sl-"));
  const ok = path.join(dir, "ok.bin");
  const res = await saveWithLimit({ createReadStream: async () => Readable.from([Buffer.from("abc")]) }, ok, 10);
  assert.deepEqual(res, { ok: true });
  assert.equal((await readFile(ok)).toString(), "abc");

  // An endless stream must be cut off by the cap rather than filling the disk.
  let produced = 0;
  const endless = new Readable({ read() { produced += 1024; this.push(Buffer.alloc(1024)); } });
  const big = path.join(dir, "big.bin");
  const tooBig = await saveWithLimit({ createReadStream: async () => endless }, big, 10_000);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.tooLarge, true);
  assert.match(tooBig.reason, /exceeds max allowed size/);
  assert.equal(await exists(big), false, "partial file is deleted");
  assert.ok(produced < 1_000_000, "stream was stopped early");
});

test("saveWithLimit handles failed downloads and falls back to saveAs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sl-"));
  const failed = await saveWithLimit({ createReadStream: async () => null }, path.join(dir, "x"), 10);
  assert.equal(failed.ok, false);

  let savedTo;
  const fb = await saveWithLimit({ saveAs: async (p) => { savedTo = p; } }, path.join(dir, "y"), 10);
  assert.deepEqual(fb, { ok: true });
  assert.equal(savedTo, path.join(dir, "y"));
});
