import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../errors.mjs";
import { validateManifest } from "../manifest.mjs";
import { Deadline } from "../runtime/deadline.mjs";
import { solveManifest, taskCacheKey } from "../solver/orchestrator.mjs";
import { fingerprint } from "../runtime/cache.mjs";

function codeHash(code) {
  return createHash("sha256").update(code).digest("hex");
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Polls visible check results until they settle or the budget runs out.
 *
 * Why: a timeout used to throw away the whole run. The unsettled statuses are the useful
 * artefact — they say which cards are still pending — and the submit gate refuses anything
 * that is not `passed`, so returning them is safe and far more informative.
 */
async function waitForChecks(browser, ids, { profile, timeoutMs, pollMs }) {
  const endsAt = Date.now() + timeoutMs;
  let statuses = [];
  while (true) {
    statuses = await browser.bridge("readChecks", { ids, profile });
    const settled =
      statuses.length === ids.length &&
      statuses.every((status) => status.state === "passed" || status.state === "failed");
    if (settled) return { statuses, settled: true };
    if (Date.now() >= endsAt) {
      return {
        statuses,
        settled: false,
        timeout: {
          code: "CHECK_TIMEOUT",
          message: "Visible Run Check results did not settle before the timeout",
          unsettled: statuses
            .filter((status) => status.state !== "passed" && status.state !== "failed")
            .map((status) => status.id),
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Every answer the solver produced, including ones kept from a failed lane.
 *
 * Why: an editor left with starter code fails its visible check for certain. A retained
 * candidate at least gets judged by the page, which is the only oracle that counts.
 */
function answerCodeMap(report) {
  return new Map(
    report.results
      .filter((result) => typeof result.code === "string" && result.code.length > 0)
      .map((result) => [result.id, result.code]),
  );
}

function solutionsFromMap(tasks, codes) {
  return tasks
    .filter((task) => codes.has(task.id))
    .map((task) => ({ id: task.id, code: codes.get(task.id) }));
}

function missingIds(tasks, codes) {
  return tasks.filter((task) => !codes.has(task.id)).map((task) => task.id);
}

async function fillAndVerify(browser, solutions, { allowedOrigin, profile }) {
  if (solutions.length === 0) return [];
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

export async function inspectBrowser({
  browser,
  allowedOrigin,
  profile = {},
  includePrompts = false,
}) {
  if (allowedOrigin) await browser.assertOrigin(allowedOrigin);
  return browser.bridge("inspect", { profile, includePrompts });
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
  log = () => {},
}) {
  if (totalDeadlineMs <= config.bridgeReserveMs + 2_000) {
    throw new HarnessError("Bridge deadline is too small for its final-action reserve", {
      code: "INVALID_DEADLINE",
    });
  }
  const startedAt = Date.now();
  const timeline = [];
  const diagnostics = [];
  const deadline = new Deadline(totalDeadlineMs, { autoAbort: false });

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
  phase(timeline, "capture", startedAt, {
    tasks: manifest.tasks.length,
    cardCount: captured.capture?.cardCount ?? manifest.tasks.length,
    expandedRegions: captured.capture?.expandedRegions ?? 0,
    skipped: captured.capture?.skipped?.length ?? 0,
  });
  if (captured.capture?.skipped?.length) {
    diagnostics.push({ code: "CARD_NOT_CAPTURED", details: captured.capture.skipped });
  }
  if (captured.capture?.remainingCollapsedRegions) {
    diagnostics.push({
      code: "COLLAPSED_REGIONS_REMAIN",
      details: { count: captured.capture.remainingCollapsedRegions },
    });
  }
  log(`browser: captured ${manifest.tasks.length} visible task(s)`);

  deadline.assertOpen("initial solve", 2_000);
  const solveBudgetMs = deadline.remainingMs() - config.bridgeReserveMs;
  if (solveBudgetMs <= 0) {
    throw new HarnessError("No model budget remains after browser preparation", {
      code: "DEADLINE_EXPIRED",
    });
  }
  const report = await solveManifest({
    manifest,
    config,
    client,
    cache,
    deadlineMs: solveBudgetMs,
    log,
  });
  const codes = answerCodeMap(report);
  const unanswered = missingIds(manifest.tasks, codes);
  if (unanswered.length > 0) {
    // Why: this used to throw. One Codex batch over the timer then discarded every card
    // that had already been solved. Fill what exists and let the visible checks judge it.
    log(`browser: ${unanswered.length} task(s) have no answer; continuing with the rest`);
    diagnostics.push({ code: "INCOMPLETE_SOLVE", details: { missing: unanswered } });
  }
  if (report.run.retainedCount > 0) {
    diagnostics.push({ code: "RETAINED_ANSWERS", details: { failures: report.run.failures } });
  }
  phase(timeline, "solve", startedAt, {
    solveElapsedMs: report.run.elapsedMs,
    solvedCount: report.run.solvedCount,
    answered: codes.size,
    missing: unanswered.length,
  });

  let solutions = solutionsFromMap(manifest.tasks, codes);
  if (solutions.length === 0) {
    throw new HarnessError("The solver produced no answer for any visible card", {
      code: "INCOMPLETE_SOLVE",
      details: { missing: unanswered },
    });
  }
  const editors = await fillAndVerify(browser, solutions, { allowedOrigin, profile });
  phase(timeline, "fill", startedAt, {
    filled: editors.length,
    editorKinds: [...new Set(editors.map((editor) => editor.editorKind))],
  });

  deadline.assertOpen("visible checks", 1_000);
  await browser.bridge("clickChecks", {
    ids: solutions.map((solution) => solution.id),
    profile,
  });
  let checkResult = await waitForChecks(
    browser,
    solutions.map((solution) => solution.id),
    {
      profile,
      timeoutMs: Math.min(
        config.bridgeCheckTimeoutMs,
        Math.max(1, deadline.remainingMs() - 2_000),
      ),
      pollMs: config.bridgePollMs,
    },
  );
  let statuses = checkResult.statuses;
  if (checkResult.timeout) diagnostics.push(checkResult.timeout);
  phase(timeline, "checks", startedAt, {
    settled: checkResult.settled,
    passed: statuses.filter((status) => status.state === "passed").length,
    failed: statuses.filter((status) => status.state === "failed").length,
  });

  const failedIds = statuses
    .filter((status) => status.state === "failed")
    .map((status) => status.id);
  if (failedIds.length > 0) {
    const repairBudgetMs =
      deadline.remainingMs() - config.bridgeCheckTimeoutMs - 2_000;
    if (repairBudgetMs <= 1_000) {
      diagnostics.push({
        code: "REPAIR_BUDGET_EXHAUSTED",
        details: { statuses: statuses.filter((status) => status.state === "failed") },
      });
    } else {
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
        batchSize: 1,
      };
      const repairReport = await solveManifest({
        manifest: repairManifest,
        config: repairConfig,
        client,
        cache,
        deadlineMs: repairBudgetMs,
        log,
      });
      const repairedCodes = answerCodeMap(repairReport);
      const unrepaired = missingIds(repairManifest.tasks, repairedCodes);
      if (unrepaired.length > 0) {
        // A failed repair leaves the earlier answer in place rather than clearing the card.
        diagnostics.push({ code: "REPAIR_INCOMPLETE", details: { missing: unrepaired } });
      }
      const repairedSolutions = solutionsFromMap(repairManifest.tasks, repairedCodes);
      if (repairedSolutions.length > 0) {
        for (const [id, code] of repairedCodes) codes.set(id, code);
        await fillAndVerify(browser, repairedSolutions, { allowedOrigin, profile });
        const repairedIds = repairedSolutions.map((solution) => solution.id);
        await browser.bridge("clickChecks", { ids: repairedIds, profile });
        const repaired = await waitForChecks(browser, repairedIds, {
          profile,
          timeoutMs: Math.min(
            config.bridgeCheckTimeoutMs,
            Math.max(1, deadline.remainingMs() - 2_000),
          ),
          pollMs: config.bridgePollMs,
        });
        if (repaired.timeout) diagnostics.push(repaired.timeout);
        const byId = new Map(repaired.statuses.map((status) => [status.id, status]));
        statuses = statuses.map((status) => byId.get(status.id) || status);
        checkResult = { statuses, settled: checkResult.settled && repaired.settled };
        phase(timeline, "repair", startedAt, {
          passed: repaired.statuses.filter((status) => status.state === "passed").length,
          failed: repaired.statuses.filter((status) => status.state === "failed").length,
        });
        solutions = solutionsFromMap(manifest.tasks, codes);
      }
    }
  }

  const notPassed = statuses.filter((status) => status.state !== "passed");
  if (notPassed.length > 0) {
    diagnostics.push({
      code: "VISIBLE_CHECK_FAILED",
      details: { statuses: notPassed },
    });
  }

  await browser.assertOrigin(allowedOrigin);
  const finalVerification = await browser.bridge("verify", { solutions, profile });
  const drifted = finalVerification.filter((item) => !item.matches).map((item) => item.id);
  if (drifted.length > 0) {
    throw new HarnessError("Final editor verification failed after checks", {
      code: "EDITOR_VERIFY_FAILED",
      details: { drifted },
    });
  }

  const cardCount = captured.capture?.cardCount ?? manifest.tasks.length;
  // Every gate that must hold before a submission token may exist at all.
  const complete =
    unanswered.length === 0 &&
    notPassed.length === 0 &&
    solutions.length === cardCount &&
    manifest.tasks.length === cardCount;

  for (const task of manifest.tasks) {
    const code = codes.get(task.id);
    const passed = statuses.find((status) => status.id === task.id)?.state === "passed";
    // Only cache what the page itself accepted.
    if (code && passed) await cache.put("solutions", taskCacheKey(task), { code });
  }

  const base = {
    runId: manifest.run.id,
    complete,
    taskCount: manifest.tasks.length,
    cardCount,
    answeredCount: solutions.length,
    passedCount: statuses.filter((status) => status.state === "passed").length,
    elapsedMs: Date.now() - startedAt,
    timerRemainingMs: Math.max(0, totalDeadlineMs - (Date.now() - startedAt)),
    submitted: false,
    diagnostics,
    timeline,
  };

  if (!complete) {
    // No verification state and no token: `submit` has nothing to act on.
    phase(timeline, "incomplete", startedAt, {
      missing: unanswered.length,
      notPassed: notPassed.length,
    });
    log(
      `browser: run is not submittable (${unanswered.length} unanswered, ` +
      `${notPassed.length} check(s) not passing)`,
    );
    return base;
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
    cardCount,
    codeHashes: Object.fromEntries(solutions.map(({ id, code }) => [id, codeHash(code)])),
    profile,
  };
  const verificationToken = fingerprint(state).slice(0, 24);
  await writePrivateJson(verificationStatePath, { ...state, verificationToken });
  phase(timeline, "verified", startedAt, { allPassed: true });

  return { ...base, verificationToken, verificationStatePath };
}

export async function submitVerifiedBrowserRun({
  browser,
  verificationStatePath,
  verificationToken,
}) {
  let state;
  try {
    state = JSON.parse(await readFile(verificationStatePath, "utf8"));
  } catch (error) {
    throw new HarnessError(
      "No verified browser run is available to submit; run the bridge first",
      { code: "SUBMIT_GATE_REJECTED", cause: error },
    );
  }
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
      details: { expected: state.cardCount, actual: currentEditors.length },
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
  const notPassed = statuses.filter((status) => status.state !== "passed");
  if (statuses.length !== state.cardCount || notPassed.length > 0) {
    throw new HarnessError("Not every visible check is passing at submit time", {
      code: "SUBMIT_GATE_REJECTED",
      details: { checked: statuses.length, expected: state.cardCount, notPassed },
    });
  }

  const result = await browser.bridge("submit", { profile: state.profile });
  return { ...result, runId: state.runId, submitted: true };
}

export { answerCodeMap, codeHash, waitForChecks };
