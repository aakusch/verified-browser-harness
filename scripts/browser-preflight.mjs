import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBrowserSession } from "../src/browser/agent-browser.mjs";
import {
  captureBrowser,
  inspectBrowser,
  runBrowserBridge,
  submitVerifiedBrowserRun,
} from "../src/browser/runner.mjs";
import { loadConfig } from "../src/config.mjs";
import { HarnessError } from "../src/errors.mjs";
import { MockModelClient } from "../src/model/mock.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";
import { startDemoServer } from "./serve-demo.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const session = `cheetcode-preflight-${process.pid}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), "cheetcode-browser-preflight-"));
const server = await startDemoServer();
const browser = new AgentBrowserSession({ session });

class RepairingMockClient {
  constructor(solutions) {
    this.solutions = solutions;
    this.sentBadCandidate = false;
  }

  async structured(request) {
    const parsed = JSON.parse(request.input);
    const includesFirst = parsed.tasks?.some((task) => task.id === "problem-01");
    const overrides = { ...this.solutions };
    if (includesFirst && !this.sentBadCandidate) {
      overrides["problem-01"] = "function calculateScore() { return -1; }";
      this.sentBadCandidate = true;
    }
    return new MockModelClient(overrides).structured(request);
  }
}

/** Answers everything except one id, the way a timed-out sub-batch would. */
class PartialMockClient {
  constructor(solutions, failId) {
    this.solutions = solutions;
    this.failId = failId;
  }

  async structured(request) {
    const parsed = JSON.parse(request.input);
    if (parsed.tasks?.some((task) => task.id === this.failId)) {
      throw new HarnessError("Model request timed out", { code: "MODEL_TIMEOUT" });
    }
    return new MockModelClient(this.solutions).structured(request);
  }
}

/**
 * Answers problem-01 wrongly on the first turn but reports correct worked examples, so
 * the local self-check must catch it before anything is typed into the page.
 */
class SelfCheckingMockClient {
  constructor(solutions, examplesById) {
    this.solutions = solutions;
    this.examplesById = examplesById;
    this.turns = 0;
  }

  async structured(request) {
    this.turns += 1;
    const parsed = JSON.parse(request.input);
    const overrides = { ...this.solutions };
    for (const task of parsed.tasks) {
      const code = task.previousFailure || task.id !== "problem-01"
        ? overrides[task.id]
        : "function calculateScore() { return -1; }";
      overrides[task.id] = { code, examples: this.examplesById.get(task.id) || [] };
    }
    return new MockModelClient(overrides).structured(request);
  }
}

const summary = {};

try {
  // 1. Pre-start screen: named, not mistaken for a broken selector.
  await browser.command(["open", `${server.url}?state=prestart`], { timeoutMs: 30_000 });
  const preStart = await inspectBrowser({ browser, allowedOrigin: server.origin });
  assert.equal(preStart.cardCount, 0);
  assert.equal(preStart.pageState, "not-started");
  assert.deepEqual(preStart.pageStateEvidence.startButtons, ["Start Challenge"]);
  await assert.rejects(
    captureBrowser({ browser, allowedOrigin: server.origin }),
    (error) => error.code === "PAGE_NOT_STARTED",
  );

  // 2. Entry questionnaire: also named, and never answered by the harness.
  await browser.command(["open", `${server.url}?state=questionnaire`], { timeoutMs: 30_000 });
  const questionnaire = await inspectBrowser({ browser, allowedOrigin: server.origin });
  assert.equal(questionnaire.cardCount, 0);
  assert.equal(questionnaire.pageState, "questionnaire");
  assert.ok(questionnaire.pageStateEvidence.questionnaireFields >= 4);
  await assert.rejects(
    captureBrowser({ browser, allowedOrigin: server.origin }),
    (error) => error.code === "QUESTIONNAIRE_PRESENT",
  );

  // 3. Ready level: collapsed details are reported by inspect and expanded by capture.
  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  const inspection = await inspectBrowser({ browser, allowedOrigin: server.origin });
  assert.equal(inspection.pageState, "ready");
  assert.equal(inspection.cardCount, 25);
  assert.equal(inspection.submitButtonCount, 1);
  assert.deepEqual([...new Set(inspection.cards.map((card) => card.editorKind))], ["textarea"]);
  assert.ok(inspection.cards.every((card) => card.collapsedRegions === 1));

  const captured = await captureBrowser({
    browser,
    allowedOrigin: server.origin,
    runId: "local-capture-preflight",
  });
  assert.equal(captured.capture.cardCount, 25);
  assert.equal(captured.capture.expandedRegions, 25);
  assert.equal(captured.capture.remainingCollapsedRegions, 0);
  assert.deepEqual(captured.capture.skipped, []);

  const level = JSON.parse(
    await readFile(path.join(projectRoot, "fixtures", "browser-level1.json"), "utf8"),
  );
  const promptsById = new Map(level.tasks.map((task) => [task.id, task.prompt]));
  for (const task of captured.tasks) {
    const expected = promptsById.get(task.id);
    // Complete: the collapsed constraint is present.
    assert.ok(
      task.prompt.includes(`Hidden constraint for ${task.id}`),
      `${task.id} is missing its expanded detail text`,
    );
    // Not duplicated: the visible prompt appears exactly once.
    assert.equal(task.prompt.split(expected).length - 1, 1, `${task.id} prompt is duplicated`);
    // Free of page furniture and of the starter code.
    assert.ok(!task.prompt.includes("Show details"), `${task.id} captured a toggle label`);
    assert.ok(!task.prompt.includes("Run Check"), `${task.id} captured a button label`);
    assert.ok(!task.prompt.includes("function "), `${task.id} captured the editor contents`);
    assert.ok(!task.prompt.includes(task.title), `${task.id} captured its own title`);
  }
  summary.expandedRegions = captured.capture.expandedRegions;
  summary.samplePrompt = captured.tasks[0].prompt;

  const fixture = JSON.parse(
    await readFile(path.join(projectRoot, "fixtures", "browser-solutions.json"), "utf8"),
  );
  const config = loadConfig({
    CHEETCODE_CACHE_DIR: temporary,
    CHEETCODE_BRIDGE_POLL_MS: "20",
  }, projectRoot);

  // 4. Clean run: verified, not submitted.
  const verificationStatePath = path.join(temporary, "verification.json");
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: server.origin,
    config,
    client: new MockModelClient(fixture.solutions),
    cache: new SolverCache(path.join(temporary, "solutions")),
    totalDeadlineMs: 60_000,
    runId: "local-browser-preflight",
    verificationStatePath,
  });
  assert.equal(result.complete, true);
  assert.equal(result.taskCount, 25);
  assert.equal(result.passedCount, 25);
  assert.equal(result.submitted, false);
  assert.ok(result.timerRemainingMs > 50_000);
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);

  await assert.rejects(
    submitVerifiedBrowserRun({
      browser,
      verificationStatePath,
      verificationToken: "wrong-token",
    }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);

  const submitted = await submitVerifiedBrowserRun({
    browser,
    verificationStatePath,
    verificationToken: result.verificationToken,
  });
  assert.equal(submitted.submitted, true);
  assert.equal(await browser.evaluateSource("window.__submitCount"), 1);

  // 5. Pre-fill self-check: a wrong candidate is corrected before the page ever sees it.
  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  const examplesById = new Map(level.tasks.map((task) => [
    task.id,
    task.tests.map((visibleTest) => ({
      argsJson: JSON.stringify(visibleTest.args),
      expectedJson: JSON.stringify(visibleTest.expected),
    })),
  ]));
  const selfCheckStatePath = path.join(temporary, "self-check-verification.json");
  const selfCheckResult = await runBrowserBridge({
    browser,
    allowedOrigin: server.origin,
    config,
    client: new SelfCheckingMockClient(fixture.solutions, examplesById),
    cache: new SolverCache(path.join(temporary, "self-check-solutions")),
    totalDeadlineMs: 60_000,
    runId: "local-browser-self-check-preflight",
    verificationStatePath: selfCheckStatePath,
  });
  assert.equal(selfCheckResult.complete, true);
  assert.equal(selfCheckResult.passedCount, 25);
  // The correction happened during solve, so no post-check repair round trip was needed.
  assert.equal(selfCheckResult.timeline.find((item) => item.name === "repair"), undefined);
  assert.equal(
    selfCheckResult.timeline.find((item) => item.name === "checks").failed,
    0,
    "the wrong candidate should never have reached a visible check",
  );
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);
  summary.selfCheckElapsedMs = selfCheckResult.elapsedMs;

  // 6. Repair cycle: one bad candidate is corrected through the visible check.
  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  const repairStatePath = path.join(temporary, "repair-verification.json");
  const repairResult = await runBrowserBridge({
    browser,
    allowedOrigin: server.origin,
    config,
    client: new RepairingMockClient(fixture.solutions),
    cache: new SolverCache(path.join(temporary, "repair-solutions")),
    totalDeadlineMs: 60_000,
    runId: "local-browser-repair-preflight",
    verificationStatePath: repairStatePath,
  });
  const repairPhase = repairResult.timeline.find((item) => item.name === "repair");
  assert.equal(repairPhase?.passed, 1);
  assert.equal(repairPhase?.failed, 0);
  assert.equal(repairResult.complete, true);
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);

  // 7. Partial lane failure: 24 cards keep their answers and nothing is submittable.
  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  const partialStatePath = path.join(temporary, "partial-verification.json");
  const partialResult = await runBrowserBridge({
    browser,
    allowedOrigin: server.origin,
    config,
    client: new PartialMockClient(fixture.solutions, "problem-25"),
    cache: new SolverCache(path.join(temporary, "partial-solutions")),
    totalDeadlineMs: 60_000,
    runId: "local-browser-partial-preflight",
    verificationStatePath: partialStatePath,
  });
  assert.equal(partialResult.complete, false);
  assert.equal(partialResult.answeredCount, 24);
  assert.equal(partialResult.passedCount, 24);
  assert.equal(partialResult.verificationToken, undefined);
  assert.ok(partialResult.diagnostics.some((item) => item.code === "INCOMPLETE_SOLVE"));
  await assert.rejects(
    submitVerifiedBrowserRun({
      browser,
      verificationStatePath: partialStatePath,
      verificationToken: "anything",
    }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    cardCount: result.taskCount,
    elapsedMs: result.elapsedMs,
    timerRemainingMs: result.timerRemainingMs,
    preStartDetected: true,
    questionnaireDetected: true,
    expandedRegions: summary.expandedRegions,
    samplePrompt: summary.samplePrompt,
    submitGateTested: true,
    repairCycleTested: true,
    selfCheckBeforeFillTested: true,
    selfCheckElapsedMs: summary.selfCheckElapsedMs,
    partialRunAnswered: partialResult.answeredCount,
    partialRunSubmittable: Boolean(partialResult.verificationToken),
    timeline: result.timeline,
    partialTimeline: partialResult.timeline,
  }, null, 2)}\n`);
} finally {
  await browser.command(["close"]).catch(() => {});
  await server.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
