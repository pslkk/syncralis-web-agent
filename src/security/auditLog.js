import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

function redact(value) {
  if (!config.REDACT_QUERIES_IN_LOGS) return value;
  if (typeof value !== "string") return value;
  return value.length > 8 ? `${value.slice(0, 4)}…(redacted)` : "(redacted)";
}

// File writes are serialized so lines never interleave and size accounting stays correct.
let chain = Promise.resolve();
let currentSize = null;
let dirReady = false;

async function writeLine(line) {
  const file = config.AUDIT_LOG_PATH;
  if (!dirReady) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    dirReady = true;
  }
  if (currentSize === null) currentSize = (await stat(file).catch(() => ({ size: 0 }))).size;
  const bytes = Buffer.byteLength(line) + 1;
  if (config.AUDIT_LOG_MAX_BYTES > 0 && currentSize + bytes > config.AUDIT_LOG_MAX_BYTES) {
    // Keep exactly one previous generation (file.1); bounded disk use.
    await rename(file, `${file}.1`).catch(() => {});
    currentSize = 0;
  }
  await appendFile(file, line + "\n", { mode: 0o600 });
  currentSize += bytes;
}

export async function logEvent(event) {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
    query: event.query !== undefined ? redact(event.query) : undefined,
  };
  const line = JSON.stringify(entry);

  console.error(`[audit] ${line}`);

  if (config.AUDIT_LOG_PATH) {
    chain = chain
      .then(() => writeLine(line))
      .catch((err) => {
        console.error(`[audit] failed to write audit log file: ${err.message}`);
      });
    await chain;
  }
}
