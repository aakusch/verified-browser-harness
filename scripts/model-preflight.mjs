import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { OpenAIModelClient } from "../src/model/openai.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";
import { solveManifest } from "../src/solver/orchestrator.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (!process.env.OPENAI_API_KEY) {
  process.stdout.write(`${JSON.stringify({
    skipped: true,
    reason: "OPENAI_API_KEY is not present",
    challengeAttemptsUsed: 0,
  }, null, 2)}\n`);
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "cheetcode-model-preflight-"));
try {
  const config = loadConfig({
    ...process.env,
    CHEETCODE_CACHE_DIR: temporary,
  }, projectRoot);
  const manifest = await loadManifest(
    path.join(projectRoot, "fixtures", "browser-level1.json"),
  );
  const startedAt = Date.now();
  const report = await solveManifest({
    manifest,
    config,
    client: new OpenAIModelClient(config),
    cache: new SolverCache(temporary),
    deadlineMs: manifest.run.deadlineMs - config.bridgeReserveMs,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const summary = {
    skipped: false,
    complete: report.run.complete,
    taskCount: report.run.taskCount,
    solvedCount: report.run.solvedCount,
    wallTimeMs: Date.now() - startedAt,
    solverElapsedMs: report.run.elapsedMs,
    browserReserveMs: config.bridgeReserveMs,
    model: config.fastModel,
    serviceTierRequested: config.serviceTier,
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
