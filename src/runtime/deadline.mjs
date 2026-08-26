import { HarnessError } from "../errors.mjs";

export class Deadline {
  constructor(durationMs, { reserveMs = 0, now = Date.now, autoAbort = true } = {}) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new HarnessError("Deadline duration must be positive", {
        code: "INVALID_DEADLINE",
      });
    }
    this.durationMs = durationMs;
    this.reserveMs = Math.max(0, reserveMs);
    this.now = now;
    this.startedAt = now();
    this.endsAt = this.startedAt + durationMs;
    this.controller = new AbortController();
    // Why: a model call that outlives the level timer is pure waste — the answer can no
    // longer be typed into the page. Aborting at the reserve boundary frees the run to
    // spend its last seconds filling and verifying whatever already succeeded.
    this.timer = autoAbort
      ? setTimeout(() => this.abort("deadline reached"), Math.max(1, this.remainingMs()))
      : null;
    this.timer?.unref?.();
  }

  get signal() {
    return this.controller.signal;
  }

  abort(reason = "aborted") {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new HarnessError(`Deadline ${reason}`, { code: "DEADLINE_EXPIRED" }));
    }
  }

  /** Releases the abort timer. Safe to call more than once. */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  elapsedMs() {
    return Math.max(0, this.now() - this.startedAt);
  }

  remainingMs({ includeReserve = false } = {}) {
    const reserve = includeReserve ? 0 : this.reserveMs;
    return Math.max(0, this.endsAt - this.now() - reserve);
  }

  isOpen(minimumMs = 1) {
    return this.remainingMs() >= minimumMs;
  }

  assertOpen(label = "operation", minimumMs = 1) {
    if (!this.isOpen(minimumMs)) {
      throw new HarnessError(`Deadline expired before ${label}`, {
        code: "DEADLINE_EXPIRED",
        details: { elapsedMs: this.elapsedMs(), durationMs: this.durationMs },
      });
    }
  }

  timeoutMs(capMs) {
    return Math.max(1, Math.min(capMs, this.remainingMs()));
  }
}

export async function mapConcurrent(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HarnessError("Concurrency must be at least one", {
      code: "INVALID_CONCURRENCY",
    });
  }
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}

export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
