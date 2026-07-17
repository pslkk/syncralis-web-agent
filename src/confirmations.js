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

export function stageAction(description, run) {
  ensureSweeper();
  const id = `act_${++counter}_${Date.now()}`;
  pending.set(id, { description, run, createdAt: Date.now() });
  return id;
}

export async function confirmAction(id) {
  const entry = pending.get(id);
  if (!entry) {
    return { ok: false, error: `No pending action with id "${id}" (it may have expired or already run).` };
  }
  pending.delete(id);
  if (Date.now() - entry.createdAt > TTL_MS) {
    return { ok: false, error: `Confirmation id "${id}" expired. Please retry the original action.` };
  }
  try {
    const result = await entry.run();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
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
