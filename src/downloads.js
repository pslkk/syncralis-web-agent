import { randomBytes } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

// Registry of verified downloads so remote clients can retrieve them. Entries are
// owner-scoped: a client can only ever see or fetch files it downloaded itself.

const MAX_PER_OWNER = 100;
const FILE_PATTERN = /^\d{13}-[0-9a-f]{12}-/; // names created by quarantine.js

const registry = new Map(); // id -> entry

const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv",
  json: "application/json", xml: "application/xml", md: "text/markdown",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
};

export function mimeFor(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

export function registerDownload({ owner, filePath, bytes, sha256 }) {
  const mine = [...registry.values()].filter((e) => e.owner === owner).sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= MAX_PER_OWNER) {
    const old = mine.shift();
    registry.delete(old.id);
    unlink(old.path).catch(() => {});
  }
  const id = `dl_${randomBytes(16).toString("hex")}`;
  const safeName = path.basename(filePath).replace(FILE_PATTERN, "") || "download.bin";
  registry.set(id, { id, owner, path: filePath, safeName, bytes, sha256, createdAt: Date.now() });
  return id;
}

export function getDownload(id, owner) {
  const entry = registry.get(id);
  if (!entry || entry.owner !== owner) return undefined;
  return entry;
}

/** Deletes registry entries and orphaned quarantine files older than ttlMs. */
export async function sweepDownloads(dir, ttlMs, now = Date.now()) {
  for (const [id, e] of registry) {
    if (now - e.createdAt > ttlMs) {
      registry.delete(id);
      await unlink(e.path).catch(() => {});
    }
  }
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) continue; // never touch files we did not create
    const full = path.join(dir, name);
    try {
      const s = await stat(full);
      if (s.isFile() && now - s.mtimeMs > ttlMs) await unlink(full);
    } catch {
      /* best effort */
    }
  }
}

export function startDownloadSweeper(getDir, ttlMs, intervalMs = 5 * 60 * 1000) {
  const run = () => sweepDownloads(getDir(), ttlMs).catch(() => {});
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function _resetForTests() {
  registry.clear();
}
