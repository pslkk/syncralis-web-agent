import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(laterIso, earlierIso) {
  return (new Date(laterIso).getTime() - new Date(earlierIso).getTime()) / MS_PER_DAY;
}

export function evaluatePromotion(entry, options, now = new Date()) {
  const { minConfirmations, maxAgeDays, rejectionCooldownDays } = options;
  if (!entry) return { promoted: false, reason: null };

  const nowIso = now.toISOString();

  if (entry.lastRejectedAt) {
    const daysSinceRejection = daysBetween(nowIso, entry.lastRejectedAt);
    if (daysSinceRejection < rejectionCooldownDays) {
      return {
        promoted: false,
        reason: `In local-trust-memory cooldown after a rejection ${Math.floor(daysSinceRejection)} day(s) ago`,
      };
    }
  }

  if ((entry.confirmedCount || 0) < minConfirmations) {
    return { promoted: false, reason: null };
  }

  if (entry.lastConfirmedAt) {
    const daysSinceConfirmation = daysBetween(nowIso, entry.lastConfirmedAt);
    if (daysSinceConfirmation > maxAgeDays) {
      return {
        promoted: false,
        reason: `Local trust memory for this domain expired ${Math.floor(daysSinceConfirmation)} day(s) since last confirmation`,
      };
    }
  }

  return {
    promoted: true,
    reason:
      `Auto-approved based on ${entry.confirmedCount} prior explicit user confirmations for ` +
      `this domain (local trust memory), most recently ${Math.floor(
        daysBetween(nowIso, entry.lastConfirmedAt)
      )} day(s) ago, with no rejections in the last ${rejectionCooldownDays} day(s)`,
  };
}

let writeQueue = Promise.resolve();
let cache = null; // in-memory cache of the on-disk store, loaded lazily

async function readStore(storePath) {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    // Missing file, corrupted JSON, or permissions issue — start fresh rather than crash. This is best-effort memory, not a security control.
    return {};
  }
}

async function writeStoreAtomic(storePath, data) {
  await mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${storePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmpPath, storePath);
}

async function getStore(storePath) {
  if (!cache) cache = await readStore(storePath);
  return cache;
}

export async function getMemoryEntry(storePath, domain) {
  try {
    const store = await getStore(storePath);
    return store[domain];
  } catch {
    return undefined;
  }
}

export function recordDecision(storePath, domain, decision, now = new Date()) {
  writeQueue = writeQueue
    .then(async () => {
      const store = await getStore(storePath);
      const nowIso = now.toISOString();
      const prev = store[domain] || { confirmedCount: 0, rejectedCount: 0 };

      if (decision === "confirmed") {
        store[domain] = {
          confirmedCount: (prev.confirmedCount || 0) + 1,
          rejectedCount: prev.rejectedCount || 0,
          lastConfirmedAt: nowIso,
          lastRejectedAt: prev.lastRejectedAt,
        };
      } else if (decision === "rejected") {
        store[domain] = {
          confirmedCount: 0,
          rejectedCount: (prev.rejectedCount || 0) + 1,
          lastConfirmedAt: prev.lastConfirmedAt,
          lastRejectedAt: nowIso,
        };
      } else {
        throw new Error(`Unknown trust memory decision: "${decision}"`);
      }

      cache = store;
      await writeStoreAtomic(storePath, store);
      return store[domain];
    })
    .catch((err) => {
      return { error: String(err?.message || err) };
    });
  return writeQueue;
}

export function _resetCacheForTests() {
  cache = null;
  writeQueue = Promise.resolve();
}
