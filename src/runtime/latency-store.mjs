import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../errors.mjs";

const SCHEMA_VERSION = 1;

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, observations: [] };
}

export async function readLatencyStore(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.observations)) {
      throw new Error("unsupported schema");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw new HarnessError(`Could not read latency observations: ${error.message}`, {
      code: "LATENCY_STORE_INVALID",
    });
  }
}

export function latencySummary(observations, key) {
  const durations = observations
    .filter((item) => item.key === key && Number.isSafeInteger(item.elapsedMs) && item.elapsedMs > 0)
    .map((item) => item.elapsedMs)
    .sort((left, right) => left - right);
  if (!durations.length) return { samples: 0, p95Ms: null };
  return {
    samples: durations.length,
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
  };
}

export async function recordLatencyObservation(filePath, observation) {
  if (!Number.isSafeInteger(observation.elapsedMs) || observation.elapsedMs <= 0) {
    throw new HarnessError("Latency observation must have a positive elapsedMs", {
      code: "LATENCY_STORE_INVALID",
    });
  }
  const store = await readLatencyStore(filePath);
  const next = {
    ...store,
    observations: [...store.observations, {
      key: observation.key,
      elapsedMs: observation.elapsedMs,
      taskCount: observation.taskCount,
      createdAt: new Date().toISOString(),
    }].slice(-200),
  };
  await writePrivateJson(filePath, next);
  return latencySummary(next.observations, observation.key);
}

export async function assertStrategyLatency({ filePath, key, availableMs, minimumSamples = 3 }) {
  const store = await readLatencyStore(filePath);
  const summary = latencySummary(store.observations, key);
  if (summary.samples < minimumSamples || summary.p95Ms > availableMs) {
    throw new HarnessError("Recorded model latency is not safe for this timed browser strategy", {
      code: "LATENCY_STRATEGY_REJECTED",
      details: { key, availableMs, minimumSamples, ...summary },
    });
  }
  return summary;
}
