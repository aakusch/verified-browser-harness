import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../errors.mjs";
import { validateManifest } from "../manifest.mjs";
import { Deadline, mapConcurrent } from "../runtime/deadline.mjs";
import { solveManifest, taskCacheKey } from "../solver/orchestrator.mjs";
import { fingerprint } from "../runtime/cache.mjs";
import { recordLatencyObservation } from "../runtime/latency-store.mjs";

function codeHash(code) {
  return createHash("sha256").update(code).digest("hex");
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

async function waitForChecks(browser, ids, { profile, timeoutMs, pollMs }) {
  const endsAt = Date.now() + timeoutMs;
  let statuses = [];
  while (Date.now() < endsAt) {
    statuses = await browser.bridge("readChecks", { ids, profile });
    if (
      statuses.length === ids.length &&
      statuses.every((status) => status.state === "passed" || status.state === "failed")
    ) {
      return statuses;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new HarnessError("Visible Run Check results did not settle before the timeout", {
    code: "CHECK_TIMEOUT",
    details: { statuses },
  });
}

function solvedCodeMap(report) {
  return new Map(
    report.results
      .filter((result) => result.status === "solved" && typeof result.code === "string")
      .map((result) => [result.id, result.code]),
  );
}

function solutionsFromMap(tasks, codes) {
  return tasks
    .filter((task) => codes.has(task.id))
    .map((task) => ({ id: task.id, code: codes.get(task.id) }));
}

function assertCompleteSolutions(tasks, codes) {
  const missing = tasks.filter((task) => !codes.has(task.id)).map((task) => task.id);
  if (missing.length) {
    throw new HarnessError(`Solver did not produce ${missing.length} answer(s)`, {
      code: "INCOMPLETE_SOLVE",
      details: { missing },
    });
  }
}

async function fillAndVerify(browser, solutions, { allowedOrigin, profile }) {
  await browser.assertOrigin(allowedOrigin);
  const filled = await browser.bridge("fill", { solutions, profile });
  if (filled.length !== solutions.length || filled.some((item) => !item.matches)) {
    throw new HarnessError("One or more browser editors did not retain the generated code", {
      code: "EDITOR_FILL_FAILED",
      details: {
        expected: solutions.length,
        filled: filled.map(({ id, editorKind, matches }) => ({ id, editorKind, matches })),
      },
    });
  }
  const verified = await browser.bridge("verify", { solutions, profile });
  if (verified.length !== solutions.length || verified.some((item) => !item.matches)) {
    throw new HarnessError("Browser editor verification failed", {
      code: "EDITOR_VERIFY_FAILED",
    });
  }
  return filled.map(({ id, editorKind }) => ({ id, editorKind }));
}

function phase(timeline, name, startedAt, details = {}) {
  timeline.push({ name, elapsedMs: Date.now() - startedAt, ...details });
}

export function taskLane(task) {
  const text = `${task.functionName || ""} ${task.prompt || ""}`.toLowerCase();
  if (
    /\b(graph|tree|dynamic programming|dp\b|parse|parser|validate|dependency|schedule|optim|shortest|longest|count.*order|input)\b/.test(text)
    || /^(find|plan|min|max|optimize|validate|count)[A-Z]/.test(task.functionName || "")
  ) {
    return "complex";
  }
  return "simple";
}

function partitionLane(tasks, { id, batchSize, model, reasoningEffort }) {
  const lanes = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    const number = Math.floor(index / batchSize) + 1;
    lanes.push({
      id: tasks.length <= batchSize ? id : `${id}-${number}`,
      tasks: tasks.slice(index, index + batchSize),
      model,
      reasoningEffort,
    });
  }
  return lanes;
}

export function planSolverLanes(tasks, config) {
  if (config.browserStrategy === "single-fast") {
    return [{
      id: "all-fast",
      tasks,
      model: config.fastModel,
      reasoningEffort: config.fastReasoning,
    }];
  }
  const simple = tasks.filter((task) => taskLane(task) === "simple");
  const complex = tasks.filter((task) => taskLane(task) === "complex");
  if (config.browserStrategy === "fanout-fast") {
    // Every fanout-fast lane uses the same fast model. Keeping the heuristic's
    // complex grouping here would only create extra subscription processes and
    // increase the chance of server-side queueing.
    return partitionLane(tasks, {
      id: "fast",
      batchSize: config.browserSimpleBatchSize,
      model: config.fastModel,
      reasoningEffort: config.fastReasoning,
    });
  }
  return [
    ...partitionLane(simple, {
      id: "simple",
      batchSize: config.browserSimpleBatchSize,
      model: config.fastModel,
      reasoningEffort: config.fastReasoning,
    }),
    ...partitionLane(complex, {
      id: "complex",
      batchSize: config.browserComplexBatchSize,
      model: config.strongModel,
      reasoningEffort: config.strongReasoning,
    }),
  ];
}

export function browserLatencyKey(config) {
  return [
    config.browserStrategy,
    config.fastModel,
    config.fastReasoning,
    config.strongModel,
    config.strongReasoning,
  ].join(":");
}

function laneManifest(manifest, lane, deadlineMs) {
  return validateManifest({
    schemaVersion: 1,
    run: { id: `${manifest.run.id}-${lane.id}`, deadlineMs },
    tasks: lane.tasks,
  }, `${manifest.manifestPath}.${lane.id}`);
}

export async function inspectBrowser({ browser, allowedOrigin, profile = {} }) {
  await browser.assertOrigin(allowedOrigin);
  return browser.bridge("inspect", { profile });
}

export async function captureBrowser({
  browser,
  allowedOrigin,
  profile = {},
  deadlineMs = 60_000,
  runId,
}) {
  await browser.assertOrigin(allowedOrigin);
  return browser.bridge("capture", { profile, deadlineMs, runId });
}

async function startUntilCards({ browser, allowedOrigin, profile, config, timeline, startedAt, log }) {
  const deadlineAt = Date.now() + config.bridgeStartTimeoutMs;
  let starts = 0;
  const clickedControls = new Set();
  while (Date.now() < deadlineAt) {
    const inspection = await inspectBrowser({ browser, allowedOrigin, profile });
    if (inspection.cardCount > 0) {
      phase(timeline, "start", startedAt, { clicks: starts, tasks: inspection.cardCount });
      return inspection;
    }
    if (inspection.startButtonCount !== 1) break;
    const label = inspection.startButtons?.[0];
    if (!label || clickedControls.has(label)) {
      await new Promise((resolve) => setTimeout(resolve, config.bridgeStartPollMs));
      continue;
    }
    if (typeof browser.clickVisible === "function") {
      await browser.clickVisible(label);
    } else {
      const result = await browser.bridge("startLevel", { profile });
      if (!result.clicked) break;
    }
    clickedControls.add(label);
    starts += 1;
    log(`browser: clicked visible start control (${label})`);
    await new Promise((resolve) => setTimeout(resolve, config.bridgeStartPollMs));
  }
  throw new HarnessError("Challenge cards did not appear after the authorized start sequence", {
    code: "BROWSER_START_FAILED",
    details: { clicks: starts },
  });
}

export async function runBrowserBridge({
  browser,
  allowedOrigin,
  profile = {},
  config,
  client,
  cache,
  totalDeadlineMs = 60_000,
  runId,
  verificationStatePath,
  latencyObservationPath,
  autoStart = false,
  log = () => {},
}) {
  if (totalDeadlineMs <= config.bridgeReserveMs + 2_000) {
    throw new HarnessError("Bridge deadline is too small for its final-action reserve", {
      code: "INVALID_DEADLINE",
    });
  }
  const startedAt = Date.now();
  const timeline = [];
  const deadline = new Deadline(totalDeadlineMs);

  let initialInspection = await inspectBrowser({ browser, allowedOrigin, profile });
  if (initialInspection.cardCount === 0) {
    if (initialInspection.startButtonCount === 1) {
      if (autoStart) {
        initialInspection = await startUntilCards({
          browser, allowedOrigin, profile, config, timeline, startedAt, log,
        });
      } else {
      throw new HarnessError("Challenge level has not started; use the visible Skip and Start control first", {
        code: "BROWSER_LEVEL_NOT_STARTED",
      });
      }
    } else {
      throw new HarnessError("No visible challenge cards are available", {
        code: "BROWSER_NOT_READY",
      });
    }
  }

  const captured = await captureBrowser({
    browser,
    allowedOrigin,
    profile,
    deadlineMs: totalDeadlineMs,
    runId,
  });
  const manifest = validateManifest(
    captured,
    path.join(process.cwd(), `${captured.run.id}.browser.json`),
  );
  phase(timeline, "capture", startedAt, { tasks: manifest.tasks.length });
  log(`browser: captured ${manifest.tasks.length} visible task(s)`);
  const capturePath = path.join(
    config.cacheDir,
    "browser-runs",
    `${manifest.run.id.replace(/[^a-zA-Z0-9_.-]+/g, "-")}.capture.json`,
  );
  await writePrivateJson(capturePath, captured);

  const repairReserveMs = config.browserStrategy === "repair"
    ? config.bridgeRepairReserveMs
    : 0;
  deadline.assertOpen("initial solve", config.bridgeReserveMs + repairReserveMs + 1_000);
  const initialSolveBudgetMs = deadline.remainingMs({ includeReserve: true })
    - config.bridgeReserveMs
    - repairReserveMs;
  const lanes = planSolverLanes(manifest.tasks, config);
  const runTracePath = path.join(
    config.cacheDir,
    "browser-runs",
    `${manifest.run.id.replace(/[^a-zA-Z0-9_.-]+/g, "-")}.run.json`,
  );
  const laneEvents = [];
  let traceWrite = Promise.resolve();
  const recordLaneEvent = async (name, details = {}) => {
    laneEvents.push({ name, elapsedMs: Date.now() - startedAt, ...details });
    traceWrite = traceWrite.then(() => writePrivateJson(runTracePath, {
      schemaVersion: 1,
      runId: manifest.run.id,
      strategy: config.browserStrategy,
      taskCount: manifest.tasks.length,
      lanes: lanes.map((lane) => ({ id: lane.id, taskIds: lane.tasks.map((task) => task.id) })),
      events: laneEvents,
    }));
    await traceWrite;
  };
  await recordLaneEvent("captured");
  const codes = new Map();
  const statusById = new Map();
  let applyQueue = Promise.resolve();

  const applySolutions = async (lane, laneCodes, phaseName) => {
    assertCompleteSolutions(lane.tasks, laneCodes);
    for (const [id, code] of laneCodes) codes.set(id, code);
    const solutions = solutionsFromMap(lane.tasks, laneCodes);
    const editors = await fillAndVerify(browser, solutions, { allowedOrigin, profile });
    phase(timeline, "fill", startedAt, {
      lane: lane.id,
      editorKinds: [...new Set(editors.map((editor) => editor.editorKind))],
    });
    await browser.bridge("clickChecks", { ids: solutions.map((solution) => solution.id), profile });
    const statuses = await waitForChecks(browser, solutions.map((solution) => solution.id), {
      profile,
      timeoutMs: Math.min(config.bridgeCheckTimeoutMs, Math.max(1, deadline.remainingMs() - 1_000)),
      pollMs: config.bridgePollMs,
    });
    for (const status of statuses) statusById.set(status.id, status);
    phase(timeline, phaseName, startedAt, {
      lane: lane.id,
      passed: statuses.filter((status) => status.state === "passed").length,
      failed: statuses.filter((status) => status.state === "failed").length,
    });
  };

  const laneFailures = [];
  await mapConcurrent(lanes, Math.min(config.browserWorkerConcurrency, lanes.length), async (lane) => {
    try {
      const remainingForInitial = Math.max(1, initialSolveBudgetMs - (Date.now() - startedAt));
      if (remainingForInitial < 1_000) {
        throw new HarnessError("Initial solve cutoff reached before this lane completed", {
          code: "DEADLINE_EXPIRED",
        });
      }
      const laneConfig = {
        ...config,
        fastModel: lane.model,
        fastReasoning: lane.reasoningEffort,
        batchSize: lane.tasks.length,
        concurrency: 1,
      };
      await recordLaneEvent("lane_started", { lane: lane.id, tasks: lane.tasks.length });
      log(`browser: solving ${lane.id} (${lane.tasks.length} task(s))`);
      const report = await solveManifest({
        manifest: laneManifest(manifest, lane, remainingForInitial),
        config: laneConfig,
        client,
        cache,
        deadlineMs: remainingForInitial,
        log,
      });
      const laneCodes = solvedCodeMap(report);
      phase(timeline, "solve", startedAt, {
        lane: lane.id,
        tasks: lane.tasks.length,
        solveElapsedMs: report.run.elapsedMs,
      });
      await recordLaneEvent("lane_solved", {
        lane: lane.id,
        solved: laneCodes.size,
        solverElapsedMs: report.run.elapsedMs,
      });
      applyQueue = applyQueue.then(() => applySolutions(lane, laneCodes, "checks"));
      await applyQueue;
    } catch (error) {
      const normalized = error instanceof HarnessError ? error : new HarnessError(String(error), {
        code: "LANE_FAILED",
      });
      laneFailures.push({ lane: lane.id, code: normalized.code, message: normalized.message });
      phase(timeline, "lane_failed", startedAt, { lane: lane.id, code: normalized.code });
      await recordLaneEvent("lane_failed", { lane: lane.id, code: normalized.code });
      log(`browser: ${lane.id} did not complete: ${normalized.message}`);
    }
  });
  await traceWrite;

  if (latencyObservationPath && laneFailures.length === 0) {
    await recordLatencyObservation(latencyObservationPath, {
      key: browserLatencyKey(config),
      elapsedMs: Date.now() - startedAt,
      taskCount: manifest.tasks.length,
    });
  }

  let statuses = manifest.tasks.map((task) => statusById.get(task.id) || ({
    id: task.id,
    state: "unknown",
    text: "No visible check result",
  }));
  const failedIds = statuses.filter((status) => status.state === "failed").map((status) => status.id);
  if (failedIds.length > 0 && repairReserveMs > 0) {
    const repairBudgetMs = deadline.remainingMs() - config.bridgeReserveMs - 1_000;
    if (repairBudgetMs <= 1_000) {
      throw new HarnessError("Visible checks failed without enough time for a repair cycle", {
        code: "VISIBLE_CHECK_FAILED",
        details: { statuses: statuses.filter((status) => status.state === "failed") },
      });
    }
    log(`browser: repairing ${failedIds.length} visible check failure(s)`);
    const feedback = new Map(statuses.map((status) => [status.id, status.text]));
    const repairManifest = validateManifest({
      schemaVersion: 1,
      run: { id: `${manifest.run.id}-repair`, deadlineMs: repairBudgetMs },
      tasks: manifest.tasks
        .filter((task) => failedIds.includes(task.id))
        .map((task) => ({
          ...task,
          prompt: `${task.prompt}\n\nThe visible Run Check failed with this result: ${feedback.get(task.id) || "failed"}. Return a corrected implementation.`,
        })),
    }, path.join(process.cwd(), `${manifest.run.id}.repair.json`));
    const repairConfig = {
      ...config,
      fastModel: config.strongModel,
      fastReasoning: config.strongReasoning,
      batchSize: failedIds.length,
      concurrency: 1,
    };
    const repairReport = await solveManifest({
      manifest: repairManifest,
      config: repairConfig,
      client,
      cache,
      deadlineMs: repairBudgetMs,
      log,
    });
    const repairedCodes = solvedCodeMap(repairReport);
    assertCompleteSolutions(repairManifest.tasks, repairedCodes);
    await applySolutions({ id: "repair", tasks: repairManifest.tasks }, repairedCodes, "repair");
    statuses = manifest.tasks.map((task) => statusById.get(task.id) || ({
      id: task.id,
      state: "unknown",
      text: "No visible check result",
    }));
  }

  const notPassed = statuses.filter((status) => status.state !== "passed");
  if (notPassed.length > 0) {
    throw new HarnessError(`${notPassed.length} visible check(s) are not passing`, {
      code: "VISIBLE_CHECK_FAILED",
      details: { statuses: notPassed, laneFailures },
    });
  }

  await browser.assertOrigin(allowedOrigin);
  const solutions = solutionsFromMap(manifest.tasks, codes);
  const finalVerification = await browser.bridge("verify", { solutions, profile });
  if (finalVerification.some((item) => !item.matches)) {
    throw new HarnessError("Final editor verification failed after checks", {
      code: "EDITOR_VERIFY_FAILED",
    });
  }

  for (const task of manifest.tasks) {
    await cache.put("solutions", taskCacheKey(task), { code: codes.get(task.id) });
  }

  const stateCreatedAt = Date.now();
  const timerDeadlineAt = startedAt + totalDeadlineMs;
  const expiresAt = Math.min(
    stateCreatedAt + config.bridgeVerificationTtlMs,
    timerDeadlineAt,
  );
  const state = {
    schemaVersion: 1,
    createdAt: new Date(stateCreatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    timerDeadlineAt: new Date(timerDeadlineAt).toISOString(),
    session: browser.session,
    allowedOrigin,
    url: captured.page.url,
    runId: manifest.run.id,
    capturePath,
    cardCount: manifest.tasks.length,
    codeHashes: Object.fromEntries(solutions.map(({ id, code }) => [id, codeHash(code)])),
    profile,
  };
  const verificationToken = fingerprint(state).slice(0, 24);
  const persistedState = { ...state, verificationToken };
  await writePrivateJson(verificationStatePath, persistedState);
  phase(timeline, "verified", startedAt, { allPassed: true });

  return {
    runId: manifest.run.id,
    complete: true,
    taskCount: manifest.tasks.length,
    elapsedMs: Date.now() - startedAt,
    timerRemainingMs: Math.max(0, totalDeadlineMs - (Date.now() - startedAt)),
    verificationToken,
    verificationStatePath,
    submitted: false,
    timeline,
  };
}

export async function submitVerifiedBrowserRun({
  browser,
  verificationStatePath,
  verificationToken,
}) {
  const state = JSON.parse(await readFile(verificationStatePath, "utf8"));
  if (!verificationToken || verificationToken !== state.verificationToken) {
    throw new HarnessError("Verification token does not match the prepared browser run", {
      code: "SUBMIT_GATE_REJECTED",
    });
  }
  if (state.session !== browser.session) {
    throw new HarnessError("Verification was created for a different browser session", {
      code: "SUBMIT_GATE_REJECTED",
    });
  }
  if (Date.now() > Date.parse(state.expiresAt)) {
    throw new HarnessError("Browser verification has expired", {
      code: "SUBMIT_GATE_REJECTED",
    });
  }

  await browser.assertOrigin(state.allowedOrigin);
  const currentEditors = await browser.bridge("readEditors", { profile: state.profile });
  if (currentEditors.length !== state.cardCount) {
    throw new HarnessError("Challenge card count changed after verification", {
      code: "SUBMIT_GATE_REJECTED",
    });
  }
  for (const editor of currentEditors) {
    if (editor.actual === null || codeHash(editor.actual) !== state.codeHashes[editor.id]) {
      throw new HarnessError(`Editor ${editor.id} changed after verification`, {
        code: "SUBMIT_GATE_REJECTED",
      });
    }
  }

  const statuses = await browser.bridge("readChecks", { profile: state.profile });
  if (statuses.length !== state.cardCount || statuses.some((status) => status.state !== "passed")) {
    throw new HarnessError("Not every visible check is passing at submit time", {
      code: "SUBMIT_GATE_REJECTED",
    });
  }

  const result = await browser.bridge("submit", { profile: state.profile });
  return { ...result, runId: state.runId, submitted: true };
}

export { codeHash, waitForChecks };
