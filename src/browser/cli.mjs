#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { HarnessError, asHarnessError } from "../errors.mjs";
import { MockModelClient } from "../model/mock.mjs";
import { createModelRuntime } from "../model/provider.mjs";
import { SolverCache } from "../runtime/cache.mjs";
import { AgentBrowserSession } from "./agent-browser.mjs";
import {
  captureBrowser,
  inspectBrowser,
  runBrowserBridge,
  submitVerifiedBrowserRun,
} from "./runner.mjs";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function usage() {
  return `Usage:
  npm run bridge -- inspect --session <name> --allow-origin <origin> [--profile <json>]
  npm run bridge -- capture --session <name> --allow-origin <origin> [--out <file|->]
  npm run bridge -- run --session <name> --allow-origin <origin> [--deadline-ms 60000]
      [--provider <openai|codex|claude|cursor>] [--mock-solutions <json>]
      [--verification-state <file>] [--profile <json>]
      [--submit-after-verify SUBMIT_VERIFIED_RUN]
  npm run bridge -- submit --session <name> --verification-state <file>
      --verification-token <token>

The run command never submits unless --submit-after-verify has the exact confirmation value.
The submit command re-verifies origin, editor hashes, card count, and every visible check before clicking.`;
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
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new HarnessError(`--${name} requires a value`, { code: "INVALID_ARGUMENT" });
    }
    options[name] = value;
    index += 1;
  }
  return { command, positional, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new HarnessError(`--${name} is required`, { code: "INVALID_ARGUMENT" });
  return value;
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HarnessError(`${label} must be a positive integer`, { code: "INVALID_ARGUMENT" });
  }
  return parsed;
}

function validateAutoSubmit(value) {
  if (value === undefined) return false;
  if (value !== "SUBMIT_VERIFIED_RUN") {
    throw new HarnessError(
      "--submit-after-verify must equal SUBMIT_VERIFIED_RUN exactly",
      { code: "INVALID_ARGUMENT" },
    );
  }
  return true;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HarnessError(`${filePath} is not valid JSON`, {
        code: "INVALID_ARGUMENT",
        cause: error,
      });
    }
    throw error;
  }
}

async function loadProfile(options) {
  return options.profile ? readJson(options.profile) : {};
}

function defaultVerificationPath(config, session) {
  const safeSession = session.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return path.join(config.cacheDir, "browser-verification", `${safeSession}.json`);
}

async function outputJson(value, outputPath = "-") {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath === "-") process.stdout.write(serialized);
  else {
    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, serialized, { mode: 0o600 });
    process.stdout.write(`${resolved}\n`);
  }
}

async function runCommand(options, config, browser) {
  const allowedOrigin = requireOption(options, "allow-origin");
  const autoSubmit = validateAutoSubmit(options["submit-after-verify"]);
  const profile = await loadProfile(options);
  const totalDeadlineMs = parsePositiveInteger(
    options["deadline-ms"],
    60_000,
    "--deadline-ms",
  );
  const verificationStatePath = path.resolve(
    options["verification-state"] || defaultVerificationPath(config, browser.session),
  );
  let client;
  let cache;
  let runConfig = config;
  if (options["mock-solutions"]) {
    const fixture = await readJson(options["mock-solutions"]);
    client = new MockModelClient(fixture.solutions || fixture);
    cache = new SolverCache(path.join(config.cacheDir, "browser-mock"));
  } else {
    const runtime = createModelRuntime(config, options.provider);
    client = runtime.client;
    runConfig = runtime.config;
    cache = new SolverCache(config.cacheDir);
  }

  let result = await runBrowserBridge({
    browser,
    allowedOrigin,
    profile,
    config: runConfig,
    client,
    cache,
    totalDeadlineMs,
    runId: options["run-id"],
    verificationStatePath,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  if (autoSubmit && !result.complete) {
    // The confirmation authorises submitting a verified run, not any run.
    process.stderr.write(
      "submit skipped: the run is not fully verified; see diagnostics in the JSON result\n",
    );
  }
  if (autoSubmit && result.complete) {
    const submitStartedAt = Date.now();
    const submitted = await submitVerifiedBrowserRun({
      browser,
      verificationStatePath,
      verificationToken: result.verificationToken,
    });
    result = {
      ...result,
      submitted: true,
      submitElapsedMs: Date.now() - submitStartedAt,
      submitResult: submitted,
    };
  }
  await outputJson(result, options.out || "-");
  if (!result.complete) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, positional, options } = parseArguments(argv);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (positional.length > 0) {
    throw new HarnessError(`Unexpected argument: ${positional[0]}`, {
      code: "INVALID_ARGUMENT",
    });
  }
  const session = requireOption(options, "session");
  const config = loadConfig(process.env, projectRoot);
  const browser = new AgentBrowserSession({ session });

  if (command === "inspect") {
    const result = await inspectBrowser({
      browser,
      allowedOrigin: requireOption(options, "allow-origin"),
      profile: await loadProfile(options),
    });
    return outputJson(result, options.out || "-");
  }
  if (command === "capture") {
    const result = await captureBrowser({
      browser,
      allowedOrigin: requireOption(options, "allow-origin"),
      profile: await loadProfile(options),
      deadlineMs: parsePositiveInteger(options["deadline-ms"], 60_000, "--deadline-ms"),
      runId: options["run-id"],
    });
    return outputJson(result, options.out || "-");
  }
  if (command === "run") return runCommand(options, config, browser);
  if (command === "submit") {
    const result = await submitVerifiedBrowserRun({
      browser,
      verificationStatePath: path.resolve(requireOption(options, "verification-state")),
      verificationToken: requireOption(options, "verification-token"),
    });
    return outputJson(result, options.out || "-");
  }
  throw new HarnessError(`Unknown bridge command: ${command}\n\n${usage()}`, {
    code: "INVALID_ARGUMENT",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const normalized = asHarnessError(error, "BRIDGE_FAILED");
    process.stderr.write(`error [${normalized.code}]: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}

export { defaultVerificationPath, parseArguments, validateAutoSubmit };
