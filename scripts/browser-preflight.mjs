import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBrowserSession } from "../src/browser/agent-browser.mjs";
import {
  inspectBrowser,
  runBrowserBridge,
  submitVerifiedBrowserRun,
} from "../src/browser/runner.mjs";
import { loadConfig } from "../src/config.mjs";
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

try {
  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  const preStart = await inspectBrowser({ browser, allowedOrigin: server.origin });
  assert.equal(preStart.cardCount, 0);
  assert.equal(preStart.startButtonCount, 1);
  await assert.rejects(
    runBrowserBridge({
      browser,
      allowedOrigin: server.origin,
      config: loadConfig({ CHEETCODE_CACHE_DIR: temporary }, projectRoot),
      totalDeadlineMs: 60_000,
    }),
    (error) => error.code === "BROWSER_LEVEL_NOT_STARTED",
  );
  await browser.evaluateSource('document.querySelector("#start-level").click()');
  const inspection = await inspectBrowser({ browser, allowedOrigin: server.origin });
  assert.equal(inspection.cardCount, 25);
  assert.equal(inspection.submitButtonCount, 1);
  assert.deepEqual([...new Set(inspection.cards.map((card) => card.editorKind))], ["textarea"]);

  const fixture = JSON.parse(
    await readFile(path.join(projectRoot, "fixtures", "browser-solutions.json"), "utf8"),
  );
  const config = loadConfig({
    CHEETCODE_CACHE_DIR: temporary,
    CHEETCODE_BRIDGE_POLL_MS: "20",
    CHEETCODE_BROWSER_STRATEGY: "repair",
  }, projectRoot);
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
  assert.equal(result.submitted, false);
  assert.ok(result.timerRemainingMs > 50_000);
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);
  const captured = JSON.parse(await readFile(path.join(temporary, "browser-runs", "local-browser-preflight.capture.json"), "utf8"));
  assert.equal(captured.capture.expandedCount, 25);
  assert.ok(captured.tasks.every((task) => !task.prompt.includes("Open the task details")));

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

  await browser.command(["open", server.url], { timeoutMs: 30_000 });
  await browser.evaluateSource('document.querySelector("#start-level").click()');
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
  assert.equal(await browser.evaluateSource("window.__submitCount"), 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    cardCount: result.taskCount,
    elapsedMs: result.elapsedMs,
    timerRemainingMs: result.timerRemainingMs,
    submitGateTested: true,
    repairCycleTested: true,
    timeline: result.timeline,
    repairTimeline: repairResult.timeline,
  }, null, 2)}\n`);
} finally {
  await browser.command(["close"]).catch(() => {});
  await server.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
