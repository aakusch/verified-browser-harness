import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { createModelRuntime } from "../src/model/provider.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";
import { solveManifest } from "../src/solver/orchestrator.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(os.tmpdir(), "cheetcode-subscription-preflight-"));

try {
  const baseConfig = loadConfig({
    ...process.env,
    CHEETCODE_CACHE_DIR: temporary,
    CHEETCODE_MODEL_PROVIDER: "codex",
  }, projectRoot);
  const runtime = createModelRuntime(baseConfig, "codex");
  const manifest = await loadManifest(
    path.join(projectRoot, "fixtures", "browser-level1.json"),
  );
  const startedAt = Date.now();
  const report = await solveManifest({
    manifest,
    config: runtime.config,
    client: runtime.client,
    cache: new SolverCache(temporary),
    deadlineMs: manifest.run.deadlineMs - runtime.config.bridgeReserveMs,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const summary = {
    provider: runtime.provider,
    complete: report.run.complete,
    taskCount: report.run.taskCount,
    solvedCount: report.run.solvedCount,
    wallTimeMs: Date.now() - startedAt,
    solverElapsedMs: report.run.elapsedMs,
    browserReserveMs: runtime.config.bridgeReserveMs,
    model: runtime.config.fastModel,
    reasoningEffort: runtime.config.fastReasoning,
    batchSize: runtime.config.batchSize,
    subscriptionTurns: runtime.client.requestCount,
    challengeAttemptsUsed: 0,
    failures: report.results
      .filter((result) => result.status !== "solved")
      .map((result) => ({ id: result.id, error: result.error })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!report.run.complete) process.exitCode = 2;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
