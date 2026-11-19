// Small, dependency-free concurrency and rate-limiting primitives.

export class BusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BusyError";
    this.code = "BUSY";
  }
}

/**
 * Counting semaphore with a bounded wait queue and per-acquire timeout.
 * acquire() resolves to an idempotent release() function.
 */
export class Semaphore {
  #active = 0;
  #queue = [];

  constructor(max, { maxQueue = 64 } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("Semaphore max must be an integer >= 1");
    this.max = max;
    this.maxQueue = maxQueue;
  }

  get active() {
    return this.#active;
  }

  get queued() {
    return this.#queue.length;
  }

  #makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#queue.shift();
      if (next) next.grant(); // slot is handed over directly; active count unchanged
      else this.#active -= 1;
    };
  }

  acquire({ timeoutMs = 30_000 } = {}) {
    if (this.#active < this.max) {
      this.#active += 1;
      return Promise.resolve(this.#makeRelease());
    }
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(new BusyError("Server busy: too many queued browser tasks, retry shortly"));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(this.#makeRelease());
        },
      };
      entry.timer = setTimeout(() => {
        const i = this.#queue.indexOf(entry);
        if (i >= 0) this.#queue.splice(i, 1);
        reject(new BusyError("Server busy: timed out waiting for a free browser slot, retry shortly"));
      }, timeoutMs);
      this.#queue.push(entry);
    });
  }
}

/**
 * Rejects after `ms` if `promise` has not settled. The underlying work is NOT cancelled
 * (JS cannot); callers must make sure it releases its own resources when it eventually ends.
 */
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms} ms`);
      err.code = "TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Fixed-window counter keyed by an arbitrary string. */
export class FixedWindowLimiter {
  #map = new Map();

  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  #sweep(t) {
    if (this.#map.size < 5000) return;
    for (const [k, v] of this.#map) if (v.resetAt <= t) this.#map.delete(k);
  }

  /** Records one event. Returns { allowed, retryAfterMs }. */
  hit(key) {
    const t = this.now();
    this.#sweep(t);
    let entry = this.#map.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.#map.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= this.limit, retryAfterMs: Math.max(0, entry.resetAt - t) };
  }

  /** True when `key` has already used up its allowance in the current window (does not count). */
  isBlocked(key) {
    const entry = this.#map.get(key);
    return Boolean(entry && entry.resetAt > this.now() && entry.count >= this.limit);
  }

  retryAfterMs(key) {
    const entry = this.#map.get(key);
    return entry ? Math.max(0, entry.resetAt - this.now()) : 0;
  }
}
