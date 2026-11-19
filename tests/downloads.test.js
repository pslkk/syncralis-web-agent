import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerDownload, getDownload, sweepDownloads, mimeFor, _resetForTests } from "../src/downloads.js";

test("downloads are owner-scoped and expose only a sanitized name", async () => {
  _resetForTests();
  const dir = await mkdtemp(path.join(os.tmpdir(), "dl-"));
  const file = path.join(dir, "1700000000000-0123456789ab-report.pdf");
  await writeFile(file, "%PDF-1.4");

  const id = registerDownload({ owner: "alice", filePath: file, bytes: 8, sha256: "abc" });
  assert.match(id, /^dl_[0-9a-f]{32}$/);
  assert.equal(getDownload(id, "alice").safeName, "report.pdf");
  assert.equal(getDownload(id, "bob"), undefined);
  assert.equal(getDownload("dl_" + "0".repeat(32), "alice"), undefined);
});

test("sweep deletes expired files it created and never touches foreign files", async () => {
  _resetForTests();
  const dir = await mkdtemp(path.join(os.tmpdir(), "dl-"));
  const mine = path.join(dir, "1700000000000-0123456789ab-old.txt");
  const foreign = path.join(dir, "important.txt");
  await writeFile(mine, "x");
  await writeFile(foreign, "y");
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  await utimes(mine, old, old);
  await utimes(foreign, old, old);

  await sweepDownloads(dir, 60 * 60 * 1000);
  assert.deepEqual(await readdir(dir), ["important.txt"]);
});

test("mimeFor falls back to octet-stream", () => {
  assert.equal(mimeFor("a.PDF"), "application/pdf");
  assert.equal(mimeFor("a.weird"), "application/octet-stream");
});
