import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBrowserBridge, submitVerifiedBrowserRun } from "../src/browser/runner.mjs";
import { loadConfig } from "../src/config.mjs";
import { HarnessError } from "../src/errors.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = "https://replica.invalid";

function makeTasks(count) {
  return Array.from({ length: count }, (unused, index) => {
    const id = `problem-${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      functionName: `solve${index + 1}`,
      starterCode: `function solve${index + 1}(value) {\n\n}`,
      prompt: `Task ${index + 1}`,
    };
  });
}

/** An in-memory stand-in for one agent-browser page, with the same bridge contract. */
class FakeBrowser {
  constructor({ tasks, judge = () => "passed", settle = true }) {
    this.session = "fake-session";
    this.tasks = tasks;
    this.judge = judge;
    this.settle = settle;
    this.editors = new Map(tasks.map((task) => [task.id, task.starterCode]));
    this.checks = new Map(tasks.map((task) => [task.id, { state: "unknown", text: "" }]));
    this.calls = [];
    this.submitCount = 0;
  }

  async assertOrigin(allowedOrigin) {
    this.calls.push("assertOrigin");
    if (allowedOrigin !== ORIGIN) {
      throw new HarnessError("origin mismatch", { code: "BROWSER_ORIGIN_MISMATCH" });
    }
    return { origin: ORIGIN, href: `${ORIGIN}/`, title: "replica" };
  }

  async bridge(operation, payload = {}) {
    this.calls.push(operation);
    if (operation === "capture") {
      return {
        schemaVersion: 1,
        run: { id: payload.runId || "fake-run", deadlineMs: payload.deadlineMs },
        page: { url: `${ORIGIN}/`, title: "replica" },
        capture: {
          cardCount: this.tasks.length,
          expandedRegions: this.tasks.length,
          remainingCollapsedRegions: 0,
          skipped: [],
        },
        tasks: this.tasks.map((task, index) => ({
          id: task.id,
          kind: "javascript",
          pageIndex: index,
          title: task.id,
          prompt: task.prompt,
          functionName: task.functionName,
          starterCode: task.starterCode,
          tests: [],
        })),
      };
    }
    if (operation === "fill") {
      return payload.solutions.map(({ id, code }) => {
        this.editors.set(id, code);
        return { id, editorKind: "textarea", matches: true, actual: code };
      });
    }
    if (operation === "verify") {
      return payload.solutions.map(({ id, code }) => ({
        id,
        actual: this.editors.get(id) ?? null,
        matches: this.editors.get(id) === code,
      }));
    }
    if (operation === "readEditors") {
      return [...this.editors].map(([id, actual]) => ({ id, actual, editorKind: "textarea" }));
    }
    if (operation === "clickChecks") {
      const ids = payload.ids || this.tasks.map((task) => task.id);
      for (const id of ids) {
        this.checks.set(
          id,
          this.settle
            ? { state: this.judge(id, this.editors.get(id)), text: "checked" }
            : { state: "pending", text: "Checking" },
        );
      }
      return ids;
    }
    if (operation === "readChecks") {
      const ids = payload.ids || this.tasks.map((task) => task.id);
      return ids.map((id) => ({ id, ...this.checks.get(id) }));
    }
    if (operation === "submit") {
      const notPassed = [...this.checks.values()].filter((check) => check.state !== "passed");
      if (notPassed.length > 0) {
        throw new HarnessError("visible check not passing", {
          code: "VISIBLE_CHECK_NOT_PASSING",
        });
      }
      this.submitCount += 1;
      return { clicked: true, text: "Finish & Submit" };
    }
    throw new Error(`unexpected operation ${operation}`);
  }
}

/** Answers every task except the ids in `failIds`, mimicking a lane that partly fails. */
class PartialClient {
  constructor(failIds = []) {
    this.failIds = new Set(failIds);
    this.batches = [];
  }

  async structured(request) {
    const parsed = JSON.parse(request.input);
    this.batches.push(parsed.tasks.map((task) => task.id));
    const failing = parsed.tasks.filter((task) => this.failIds.has(task.id));
    if (failing.length > 0) {
      throw new HarnessError("Codex model request timed out", { code: "MODEL_TIMEOUT" });
    }
    return {
      value: {
        solutions: parsed.tasks.map((task) => ({
          id: task.id,
          code: `function ${task.functionName}(value) { return value; }`,
        })),
      },
      responseId: "partial",
      usage: null,
    };
  }
}

async function harness(t, { CHEETCODE_BRIDGE_POLL_MS = "5", ...env } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cheetcode-bridge-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return {
    config: loadConfig({ CHEETCODE_CACHE_DIR: temporary, CHEETCODE_BRIDGE_POLL_MS, ...env }, root),
    cache: new SolverCache(path.join(temporary, "solutions")),
    verificationStatePath: path.join(temporary, "verification.json"),
  };
}

test("a fully verified run produces a token and submits only through the gate", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t);
  const browser = new FakeBrowser({ tasks: makeTasks(3) });
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client: new PartialClient(),
    cache,
    totalDeadlineMs: 60_000,
    runId: "verified-run",
    verificationStatePath,
  });

  assert.equal(result.complete, true);
  assert.equal(result.submitted, false);
  assert.equal(result.answeredCount, 3);
  assert.ok(result.verificationToken);
  assert.equal(browser.submitCount, 0);

  await assert.rejects(
    submitVerifiedBrowserRun({ browser, verificationStatePath, verificationToken: "wrong" }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(browser.submitCount, 0);

  const submitted = await submitVerifiedBrowserRun({
    browser,
    verificationStatePath,
    verificationToken: result.verificationToken,
  });
  assert.equal(submitted.submitted, true);
  assert.equal(browser.submitCount, 1);
});

test("a lane that times out keeps the answers it already produced", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t);
  const tasks = makeTasks(8);
  const browser = new FakeBrowser({ tasks });
  const client = new PartialClient(["problem-07"]);
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client,
    cache,
    totalDeadlineMs: 60_000,
    runId: "partial-run",
    verificationStatePath,
  });

  // The oversized batch was split until only the failing task was lost.
  assert.ok(client.batches.length > 1, "expected the failed batch to be retried in halves");
  assert.equal(result.complete, false);
  assert.equal(result.answeredCount, 7);
  assert.equal(result.verificationToken, undefined);
  assert.equal(browser.editors.get("problem-07"), tasks[6].starterCode);
  assert.notEqual(browser.editors.get("problem-01"), tasks[0].starterCode);
  assert.ok(result.diagnostics.some((item) => item.code === "INCOMPLETE_SOLVE"));

  // Without a verification state there is nothing for the submit command to act on.
  await assert.rejects(
    submitVerifiedBrowserRun({ browser, verificationStatePath, verificationToken: "anything" }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(browser.submitCount, 0);
});

test("checks that never settle end the run without a submission token", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t, {
    CHEETCODE_BRIDGE_CHECK_TIMEOUT_MS: "60",
  });
  const browser = new FakeBrowser({ tasks: makeTasks(2), settle: false });
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client: new PartialClient(),
    cache,
    totalDeadlineMs: 60_000,
    runId: "unsettled-run",
    verificationStatePath,
  });

  assert.equal(result.complete, false);
  assert.equal(result.verificationToken, undefined);
  assert.ok(result.diagnostics.some((item) => item.code === "CHECK_TIMEOUT"));
  assert.ok(result.diagnostics.some((item) => item.code === "VISIBLE_CHECK_FAILED"));
  assert.equal(browser.submitCount, 0);
  await assert.rejects(
    readFile(verificationStatePath, "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("a failing visible check blocks the token even when every editor is filled", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t);
  const browser = new FakeBrowser({
    tasks: makeTasks(3),
    judge: (id) => (id === "problem-02" ? "failed" : "passed"),
  });
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client: new PartialClient(),
    cache,
    totalDeadlineMs: 60_000,
    runId: "failing-check-run",
    verificationStatePath,
  });

  assert.equal(result.answeredCount, 3);
  assert.equal(result.complete, false);
  assert.equal(result.verificationToken, undefined);
  assert.ok(result.diagnostics.some((item) => item.code === "VISIBLE_CHECK_FAILED"));
  assert.equal(browser.submitCount, 0);
});

test("submission is refused when a check regresses after verification", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t);
  const browser = new FakeBrowser({ tasks: makeTasks(2) });
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client: new PartialClient(),
    cache,
    totalDeadlineMs: 60_000,
    runId: "regressed-run",
    verificationStatePath,
  });
  assert.equal(result.complete, true);

  browser.checks.set("problem-02", { state: "failed", text: "Failed later" });
  await assert.rejects(
    submitVerifiedBrowserRun({
      browser,
      verificationStatePath,
      verificationToken: result.verificationToken,
    }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(browser.submitCount, 0);
});

test("submission is refused when an editor changes after verification", async (t) => {
  const { config, cache, verificationStatePath } = await harness(t);
  const browser = new FakeBrowser({ tasks: makeTasks(2) });
  const result = await runBrowserBridge({
    browser,
    allowedOrigin: ORIGIN,
    config,
    client: new PartialClient(),
    cache,
    totalDeadlineMs: 60_000,
    runId: "drifted-run",
    verificationStatePath,
  });

  browser.editors.set("problem-01", "function solve1() { return 0; }");
  await assert.rejects(
    submitVerifiedBrowserRun({
      browser,
      verificationStatePath,
      verificationToken: result.verificationToken,
    }),
    (error) => error.code === "SUBMIT_GATE_REJECTED",
  );
  assert.equal(browser.submitCount, 0);
});
