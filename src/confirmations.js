import { randomBytes } from "node:crypto";

const pending = new Map();
const DEFAULT_OWNER = "local";
const MAX_PENDING_PER_OWNER = 50;

const TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) {
      pending.delete(id);
    }
  }
}

let sweepTimer = null;
function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stageAction(description, run, meta = {}, owner = DEFAULT_OWNER) {
  ensureSweeper();
  sweepExpired();
  const mine = [...pending.entries()].filter(([, v]) => v.owner === owner);
  if (owner !== DEFAULT_OWNER && mine.length >= MAX_PENDING_PER_OWNER) {
    throw new Error("Too many actions awaiting confirmation; confirm or reject some first.");
  }
  const id = `act_${randomBytes(12).toString("hex")}`;
  pending.set(id, { description, run, createdAt: Date.now(), meta, owner });
  return id;
}

// An action is only visible to the owner that staged it.
function getOwned(id, owner) {
  const entry = pending.get(id);
  return entry && entry.owner === owner ? entry : undefined;
}

export function peekAction(id, owner = DEFAULT_OWNER) {
  const entry = getOwned(id, owner);
  if (!entry) return undefined;
  return {
    description: entry.description,
    meta: entry.meta || {},
    ageSeconds: Math.round((Date.now() - entry.createdAt) / 1000),
  };
}

export async function confirmAction(id, owner = DEFAULT_OWNER) {
  const entry = getOwned(id, owner);
  if (!entry) {
    return { ok: false, error: `No pending action with id "${id}" (it may have expired or already run).` };
  }
  pending.delete(id);
  if (Date.now() - entry.createdAt > TTL_MS) {
    return { ok: false, error: `Confirmation id "${id}" expired. Please retry the original action.`, meta: entry.meta };
  }
  try {
    const result = await entry.run();
    return { ok: true, result, meta: entry.meta };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), meta: entry.meta };
  }
}

export function rejectAction(id, owner = DEFAULT_OWNER) {
  return getOwned(id, owner) ? pending.delete(id) : false;
}

export function listPending(owner = DEFAULT_OWNER) {
  sweepExpired();
  return Array.from(pending.entries())
    .filter(([, v]) => v.owner === owner)
    .map(([id, v]) => ({
    id,
    description: v.description,
    ageSeconds: Math.round((Date.now() - v.createdAt) / 1000),
  }));
}
