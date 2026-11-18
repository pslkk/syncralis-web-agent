const pending = new Map();
let counter = 0;

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

export function stageAction(description, run, meta = {}) {
  ensureSweeper();
  const id = `act_${++counter}_${Date.now()}`;
  pending.set(id, { description, run, createdAt: Date.now(), meta });
  return id;
}

export function peekAction(id) {
  const entry = pending.get(id);
  if (!entry) return undefined;
  return {
    description: entry.description,
    meta: entry.meta || {},
    ageSeconds: Math.round((Date.now() - entry.createdAt) / 1000),
  };
}

export async function confirmAction(id) {
  const entry = pending.get(id);
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

export function rejectAction(id) {
  return pending.delete(id);
}

export function listPending() {
  sweepExpired();
  return Array.from(pending.entries()).map(([id, v]) => ({
    id,
    description: v.description,
    ageSeconds: Math.round((Date.now() - v.createdAt) / 1000),
  }));
}
