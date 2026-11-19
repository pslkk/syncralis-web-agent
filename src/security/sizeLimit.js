import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";

export class SizeLimitError extends Error {
  constructor(maxBytes) {
    super(`File exceeds max allowed size (${maxBytes} bytes)`);
    this.name = "SizeLimitError";
  }
}

/** Pass-through stream that errors as soon as more than maxBytes have flowed through. */
export function createSizeLimiter(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new SizeLimitError(maxBytes));
      else cb(null, chunk);
    },
  });
}

/**
 * Saves a Playwright download while enforcing the size cap DURING the transfer, so a hostile
 * server cannot fill the disk before the check runs. Falls back to saveAs() for download
 * objects that cannot stream (the caller re-checks the final size in that case).
 */
export async function saveWithLimit(download, destPath, maxBytes) {
  if (typeof download.createReadStream !== "function") {
    await download.saveAs(destPath);
    return { ok: true };
  }
  const readable = await download.createReadStream();
  if (!readable) return { ok: false, reason: "Download failed before any data was received" };
  try {
    await pipeline(readable, createSizeLimiter(maxBytes), createWriteStream(destPath, { mode: 0o600 }));
    return { ok: true };
  } catch (err) {
    await unlink(destPath).catch(() => {});
    if (err instanceof SizeLimitError) return { ok: false, reason: err.message, tooLarge: true };
    throw err;
  }
}
