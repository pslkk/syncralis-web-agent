import { createHash, randomBytes } from "node:crypto";
import { mkdir, stat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";

const MAGIC_BYTES = {
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
  pdf: [0x25, 0x50, 0x44, 0x46],
  zip: [0x50, 0x4b, 0x03, 0x04],
  docx: [0x50, 0x4b, 0x03, 0x04],
  xlsx: [0x50, 0x4b, 0x03, 0x04],
  pptx: [0x50, 0x4b, 0x03, 0x04],
  doc: [0xd0, 0xcf, 0x11, 0xe0],
  xls: [0xd0, 0xcf, 0x11, 0xe0],
  ppt: [0xd0, 0xcf, 0x11, 0xe0],
};

const DANGEROUS_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "sh", "msi", "scr", "com", "js", "jar", "ps1", "apk",
  "vbs", "wsf", "dll", "app", "dmg", "deb", "rpm", "iso", "lnk", "reg", "hta",
  "chm", "jse", "vbe", "wsh", "wsc", "msc", "cpl", "scf", "pif", "url", "jnlp",  
  "appx", "msix", "gadget", "workflow", "action", "command",
]);

const MACRO_OFFICE_EXTENSIONS = new Set(["docm", "xlsm", "pptm", "xlsb", "dotm", "xltm", "potm"]);
const SAFE_UNVERIFIED_EXTENSIONS = new Set(["txt", "csv", "json", "xml", "md"]);

export function quarantineDir() {
  return config.DOWNLOAD_DIR || path.join(os.tmpdir(), "syncralis-web-agent-downloads");
}

async function ensureDir() {
  const dir = quarantineDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function extOf(filename) {
  return (filename.split(".").pop() || "").toLowerCase();
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || "download.bin"));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return cleaned || "download.bin";
}

function hasHiddenDangerousExtension(filename) {
  const parts = filename.toLowerCase().split(".");
  return parts.slice(0, -1).some((p) => DANGEROUS_EXTENSIONS.has(p));
}

const OOXML_INTERNAL_MARKERS = {
  docx: "word/",
  xlsx: "xl/",
  pptx: "ppt/",
};

async function checkMagicBytes(filePath, ext) {
  const expected = MAGIC_BYTES[ext];
  if (!expected) return { ok: true, note: "No signature check defined for this extension" };

  const buf = await readFile(filePath);
  const head = Array.from(buf.subarray(0, expected.length));
  const matches = expected.every((b, i) => head[i] === b);
  if (!matches) {
    return { ok: false, note: `File signature doesn't match a real .${ext} file` };
  }

  const marker = OOXML_INTERNAL_MARKERS[ext];
  if (marker && !buf.includes(Buffer.from(marker))) {
    return {
      ok: false,
      note: `File has a ZIP signature but doesn't contain expected "${marker}" structure for .${ext}`,
    };
  }

  return { ok: true };
}

async function checkReputation(sha256) {
  if (!config.VIRUSTOTAL_API_KEY) return { checked: false };
  try {
    const resp = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { "x-apikey": config.VIRUSTOTAL_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 404) return { checked: true, known: false };
    if (!resp.ok) return { checked: false, error: `VirusTotal returned ${resp.status}` };
    const data = await resp.json();
    const stats = data?.data?.attributes?.last_analysis_stats;
    return { checked: true, known: true, stats };
  } catch (err) {
    return { checked: false, error: String(err?.message || err) };
  }
}

export async function handleDownload(download) {
  const dir = await ensureDir();
  const suggested = download.suggestedFilename() || "download.bin";
  const safeName = sanitizeFilename(suggested);
  const ext = extOf(safeName);
  const nonce = randomBytes(6).toString("hex");
  const destPath = path.join(dir, `${Date.now()}-${nonce}-${safeName}`);

  if (DANGEROUS_EXTENSIONS.has(ext) || hasHiddenDangerousExtension(safeName)) {
    await download.cancel().catch(() => {});
    return {
      ok: false,
      reason: `Refused to download file with executable/dangerous extension in "${suggested}"`,
    };
  }

  if (MACRO_OFFICE_EXTENSIONS.has(ext) && !config.ALLOW_MACRO_OFFICE_DOWNLOADS) {
    await download.cancel().catch(() => {});
    return {
      ok: false,
      reason:
        `Refused to download "${suggested}": macro-enabled Office format (.${ext}) can execute ` +
        `embedded code on open. Set SYNCRALIS_WEB_AGENT_ALLOW_MACRO_OFFICE_DOWNLOADS=true to allow this ` +
        `at your own risk.`,
    };
  }

  if (
    !MAGIC_BYTES[ext] &&
    !SAFE_UNVERIFIED_EXTENSIONS.has(ext) &&
    !config.ALLOW_UNVERIFIED_EXTENSIONS
  ) {
    await download.cancel().catch(() => {});
    return {
      ok: false,
      reason:
        `Refused to download "${suggested}": no file-signature check is defined for ".${ext}", ` +
        `so it cannot be verified. Set SYNCRALIS_WEB_AGENT_ALLOW_UNVERIFIED_EXTENSIONS=true to allow ` +
        `unverified file types at your own risk.`,
    };
  }

  await download.saveAs(destPath);

  const cleanupAndFail = async (reason, extra = {}) => {
    await unlink(destPath).catch(() => {});
    return { ok: false, reason, filename: suggested, ...extra };
  };

  const stats = await stat(destPath);
  if (stats.size > config.MAX_DOWNLOAD_BYTES) {
    return cleanupAndFail(
      `File exceeds max allowed size (${config.MAX_DOWNLOAD_BYTES} bytes)`,
      { bytes: stats.size }
    );
  }

  const sig = await checkMagicBytes(destPath, ext);
  const fileBuf = await readFile(destPath);
  const hash = createHash("sha256").update(fileBuf).digest("hex");
  const reputation = await checkReputation(hash);

  const suspiciousReputation =
    reputation.checked && reputation.known && reputation.stats?.malicious > 0;

  if (!sig.ok) {
    return cleanupAndFail(sig.note, { bytes: stats.size, sha256: hash, reputation });
  }
  if (suspiciousReputation) {
    return cleanupAndFail(
      `VirusTotal flagged this file as malicious by ${reputation.stats.malicious} engine(s)`,
      { bytes: stats.size, sha256: hash, reputation }
    );
  }

  return {
    ok: true,
    path: destPath,
    filename: suggested,
    bytes: stats.size,
    sha256: hash,
    reputation,
  };
}
