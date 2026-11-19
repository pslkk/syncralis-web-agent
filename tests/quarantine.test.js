import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { quarantineDir } from "../src/quarantine.js";

function fakeDownload({ filename, bytes }) {
  return {
    suggestedFilename: () => filename,
    saveAs: async (destPath) => {
      await writeFile(destPath, bytes);
    },
    cancel: async () => {},
  };
}

test("quarantineDir returns a usable path", () => {
  const dir = quarantineDir();
  assert.ok(typeof dir === "string" && dir.length > 0);
});

test("PNG magic bytes are correct for a real PNG", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "syncralis-web-agent-test-"));
  const pngPath = path.join(tmp, "test.png");
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(pngPath, pngHeader);
  const buf = await import("node:fs/promises").then((m) => m.readFile(pngPath));
  const head = Array.from(buf.subarray(0, 4));
  assert.deepEqual(head, [0x89, 0x50, 0x4e, 0x47]);
  await rm(tmp, { recursive: true, force: true });
});

test("refuses newly-added dangerous extension (.hta)", async () => {
  const { handleDownload } = await import("../src/quarantine.js");
  const report = await handleDownload(
    fakeDownload({ filename: "invoice.hta", bytes: Buffer.from("not really html") })
  );
  assert.equal(report.ok, false);
  assert.match(report.reason, /dangerous extension/);
});

test("refuses macro-enabled Office format by default (.docm)", async () => {
  const { handleDownload } = await import("../src/quarantine.js");
  const zipSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const filler = Buffer.from("word/document.xml fake content");
  const report = await handleDownload(
    fakeDownload({ filename: "report.docm", bytes: Buffer.concat([zipSig, filler]) })
  );
  assert.equal(report.ok, false);
  assert.match(report.reason, /macro-enabled Office/);
});

test("refuses an extension with no defined signature check by default (.xyz)", async () => {
  const { handleDownload } = await import("../src/quarantine.js");
  const report = await handleDownload(
    fakeDownload({ filename: "mystery.xyz123", bytes: Buffer.from("whatever") })
  );
  assert.equal(report.ok, false);
  assert.match(report.reason, /no file-signature check is defined/);
});

test("allows a plain-text extension with no signature check defined (.txt)", async () => {
  const { handleDownload } = await import("../src/quarantine.js");
  const report = await handleDownload(
    fakeDownload({ filename: "notes.txt", bytes: Buffer.from("hello world") })
  );
  assert.equal(report.ok, true);
});

test("still refuses a real PNG whose bytes don't match its extension (disguised executable)", async () => {
  const { handleDownload } = await import("../src/quarantine.js");
  const report = await handleDownload(
    fakeDownload({ filename: "cute-cat.png", bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) }) // "MZ" = PE/EXE header
  );
  assert.equal(report.ok, false);
  assert.match(report.reason, /signature doesn't match/);
});
