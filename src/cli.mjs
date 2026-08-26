#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { HarnessError, asHarnessError } from "./errors.mjs";
import { loadManifest } from "./manifest.mjs";
import { MockModelClient } from "./model/mock.mjs";
import { createModelRuntime } from "./model/provider.mjs";
import { SolverCache } from "./runtime/cache.mjs";
import { solveManifest } from "./solver/orchestrator.mjs";
import { buildSourceIndex, sourceIndexKey } from "./source/index.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return `Usage:
  npm run index -- <manifest.json> [--force]
  npm run solve -- <manifest.json> [--out <file|->] [--deadline-ms <ms>]
      [--provider <openai|codex>] [--mock]
  npm run materialize -- <submission.json> <output-directory>

The openai provider reads OPENAI_API_KEY from the process environment. The codex provider
uses the existing subscription-authenticated Codex CLI session. Neither reads .env files.
Use --mock only with the included fixtures.`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["mock", "force"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new HarnessError(`--${name} requires a value`, { code: "INVALID_ARGUMENT" });
    }
    options[name] = value;
    index += 1;
  }
  return { command, positional, options };
}

function safeRunId(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function getSourceIndex(manifest, cache, { force = false, log = () => {} } = {}) {
  if (manifest.sourceRoots.length === 0) return null;
  const key = { roots: sourceIndexKey(manifest.sourceRoots) };
  if (!force) {
    const cached = await cache.get("source-index", key);
    if (cached?.schemaVersion === 1) {
      log(`source index: ${cached.documents.length} cached file(s)`);
      return cached;
    }
  }
  log("source index: building from local checkouts");
  const index = await buildSourceIndex(manifest.sourceRoots);
  await cache.put("source-index", key, index);
  log(`source index: ${index.documents.length} file(s) indexed`);
  return index;
}

async function indexCommand(positional, options, config) {
  if (positional.length !== 1) throw new HarnessError(usage(), { code: "INVALID_ARGUMENT" });
  const manifest = await loadManifest(positional[0]);
  if (manifest.sourceRoots.length === 0) {
    throw new HarnessError("Manifest does not declare sourceRoots", {
      code: "SOURCE_ROOT_MISSING",
    });
  }
  const cache = new SolverCache(config.cacheDir);
  const index = await getSourceIndex(manifest, cache, {
    force: options.force,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({ key: index.key, files: index.documents.length, createdAt: index.createdAt })}\n`,
  );
}

async function solveCommand(positional, options, config) {
  if (positional.length !== 1) throw new HarnessError(usage(), { code: "INVALID_ARGUMENT" });
  const manifest = await loadManifest(positional[0]);
  const deadlineMs = options["deadline-ms"] === undefined
    ? manifest.run.deadlineMs
    : Number.parseInt(options["deadline-ms"], 10);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new HarnessError("--deadline-ms must be a positive integer", {
      code: "INVALID_ARGUMENT",
    });
  }

  const sharedCache = new SolverCache(config.cacheDir);
  const log = (message) => process.stderr.write(`${message}\n`);
  // Source preparation happens before the solve deadline starts.
  const sourceIndex = await getSourceIndex(manifest, sharedCache, { log });
  // Fixture answers must never enter the cache used by live model runs.
  const solutionCache = options.mock
    ? new SolverCache(path.join(config.cacheDir, "mock"))
    : sharedCache;
  const runtime = options.mock
    ? { provider: "mock", client: new MockModelClient(), config }
    : createModelRuntime(config, options.provider);

  log(
    `run ${manifest.run.id}: ${manifest.tasks.length} task(s), ${deadlineMs}ms budget, ${runtime.provider} provider`,
  );
  const report = await solveManifest({
    manifest,
    config: runtime.config,
    client: runtime.client,
    cache: solutionCache,
    sourceIndex,
    deadlineMs,
    log,
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputOption = options.out;
  if (outputOption === "-") {
    process.stdout.write(serialized);
  } else {
    const outputPath = path.resolve(
      outputOption || path.join(projectRoot, "out", `${safeRunId(manifest.run.id)}.submission.json`),
    );
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { mode: 0o600 });
    process.stdout.write(`${outputPath}\n`);
  }
  if (!report.run.complete) process.exitCode = 2;
}

function resolveContainedPath(root, relativePath) {
  if (
    relativePath === "" ||
    relativePath === "." ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\u0000")
  ) {
    throw new HarnessError(`Unsafe generated path: ${relativePath}`, {
      code: "UNSAFE_OUTPUT_PATH",
    });
  }
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new HarnessError(`Generated path escapes output directory: ${relativePath}`, {
      code: "UNSAFE_OUTPUT_PATH",
    });
  }
  return resolved;
}

async function materializeCommand(positional) {
  if (positional.length !== 2) throw new HarnessError(usage(), { code: "INVALID_ARGUMENT" });
  const submissionPath = path.resolve(positional[0]);
  const outputRoot = path.resolve(positional[1]);
  const submission = JSON.parse(await readFile(submissionPath, "utf8"));
  const systemsResults = (submission.results || []).filter(
    (result) => result.kind === "systems" && result.status === "solved",
  );
  if (systemsResults.length !== 1) {
    throw new HarnessError("Submission must contain exactly one solved systems task", {
      code: "INVALID_SUBMISSION",
    });
  }
  const plannedFiles = systemsResults[0].files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new HarnessError("Submission contains an invalid generated file", {
        code: "INVALID_SUBMISSION",
      });
    }
    return { ...file, target: resolveContainedPath(outputRoot, file.path) };
  });
  if (new Set(plannedFiles.map((file) => file.target)).size !== plannedFiles.length) {
    throw new HarnessError("Submission contains duplicate generated paths", {
      code: "INVALID_SUBMISSION",
    });
  }

  await mkdir(outputRoot, { recursive: true });
  for (const file of plannedFiles) {
    const target = file.target;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: 0o600 });
  }
  process.stdout.write(`${outputRoot}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, positional, options } = parseArguments(argv);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = loadConfig(process.env, projectRoot);
  if (command === "index") return indexCommand(positional, options, config);
  if (command === "solve") return solveCommand(positional, options, config);
  if (command === "materialize") return materializeCommand(positional);
  throw new HarnessError(`Unknown command: ${command}\n\n${usage()}`, {
    code: "INVALID_ARGUMENT",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const normalized = asHarnessError(error, "CLI_FAILED");
    process.stderr.write(`error [${normalized.code}]: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}

export { getSourceIndex, parseArguments, resolveContainedPath };
