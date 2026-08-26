import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertStrategyLatency,
  latencySummary,
  recordLatencyObservation,
} from "../src/runtime/latency-store.mjs";

test("latency store uses a conservative p95 and rejects unmeasured strategies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cheetcode-latency-test-"));
  const filePath = path.join(directory, "latency.json");
  try {
    await assert.rejects(
      assertStrategyLatency({ filePath, key: "single-fast:luna:low:terra:medium", availableMs: 50, minimumSamples: 3 }),
      (error) => error.code === "LATENCY_STRATEGY_REJECTED",
    );
    for (const elapsedMs of [20, 30, 60]) {
      await recordLatencyObservation(filePath, { key: "single-fast:luna:low:terra:medium", elapsedMs, taskCount: 25 });
    }
    assert.deepEqual(latencySummary([
      { key: "a", elapsedMs: 20 }, { key: "a", elapsedMs: 30 }, { key: "a", elapsedMs: 60 },
    ], "a"), { samples: 3, p95Ms: 60 });
    await assert.rejects(
      assertStrategyLatency({ filePath, key: "single-fast:luna:low:terra:medium", availableMs: 50, minimumSamples: 3 }),
      (error) => error.code === "LATENCY_STRATEGY_REJECTED",
    );
    const summary = await assertStrategyLatency({
      filePath, key: "single-fast:luna:low:terra:medium", availableMs: 60, minimumSamples: 3,
    });
    assert.deepEqual(summary, { samples: 3, p95Ms: 60 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
