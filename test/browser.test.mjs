import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentBrowserJson } from "../src/browser/agent-browser.mjs";
import {
  defaultVerificationPath,
  parseArguments,
  validateAutoStart,
  validateAutoSubmit,
} from "../src/browser/cli.mjs";
import {
  codeHash,
  browserLatencyKey,
  planSolverLanes,
  runBrowserBridge,
  taskLane,
} from "../src/browser/runner.mjs";

test("browser CLI parses an explicitly scoped run", () => {
  assert.deepEqual(
    parseArguments([
      "run",
      "--session",
      "cheetcode",
      "--allow-origin",
      "https://ctf.firecrawl.dev",
      "--deadline-ms",
      "60000",
    ]),
    {
      command: "run",
      positional: [],
      options: {
        session: "cheetcode",
        "allow-origin": "https://ctf.firecrawl.dev",
        "deadline-ms": "60000",
      },
    },
  );
});

test("browser verification paths and code hashes are stable", () => {
  assert.equal(
    defaultVerificationPath({ cacheDir: "/tmp/cache" }, "challenge/session"),
    "/tmp/cache/browser-verification/challenge-session.json",
  );
  assert.equal(codeHash("same"), codeHash("same"));
  assert.notEqual(codeHash("same"), codeHash("changed"));
});

test("browser auto-submit requires the exact explicit confirmation", () => {
  assert.equal(validateAutoSubmit(undefined), false);
  assert.equal(validateAutoSubmit("SUBMIT_VERIFIED_RUN"), true);
  assert.throws(
    () => validateAutoSubmit("yes"),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("browser auto-start requires the exact explicit confirmation", () => {
  assert.equal(validateAutoStart(undefined), false);
  assert.equal(validateAutoStart("START_LEVEL"), true);
  assert.throws(
    () => validateAutoStart("yes"),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("browser run starts visible level controls only with explicit authorization", async () => {
  let starts = 0;
  const browser = {
    session: "start-test",
    async assertOrigin() {},
    async bridge(operation) {
      if (operation === "inspect") {
        return starts ? { cardCount: 1, startButtonCount: 0 } : { cardCount: 0, startButtonCount: 1 };
      }
      assert.equal(operation, "startLevel");
      starts += 1;
      return { clicked: true, text: "L1 Orchestrate 60s" };
    },
  };
  await assert.rejects(
    runBrowserBridge({
      browser,
      allowedOrigin: "https://ctf.firecrawl.dev",
      config: { bridgeReserveMs: 12_000, bridgeStartTimeoutMs: 100, bridgeStartPollMs: 1 },
      totalDeadlineMs: 60_000,
    }),
    (error) => error.code === "BROWSER_LEVEL_NOT_STARTED",
  );
  await assert.rejects(
    runBrowserBridge({
      browser,
      allowedOrigin: "https://ctf.firecrawl.dev",
      config: { bridgeReserveMs: 12_000, bridgeStartTimeoutMs: 100, bridgeStartPollMs: 1 },
      totalDeadlineMs: 60_000,
      autoStart: true,
    }),
    () => true,
  );
  assert.equal(starts, 1);
});

test("agent-browser JSON parser returns only the evaluated result", () => {
  assert.deepEqual(
    parseAgentBrowserJson(JSON.stringify({
      success: true,
      data: { result: { ok: true } },
      error: null,
    })),
    { ok: true },
  );
});

test("browser scheduler reserves stronger lanes for complex or opaque tasks", () => {
  const config = {
    browserStrategy: "one-shot",
    fastModel: "fast",
    fastReasoning: "low",
    strongModel: "strong",
    strongReasoning: "medium",
    browserSimpleBatchSize: 12,
    browserComplexBatchSize: 4,
  };
  const simple = { id: "simple", functionName: "calculateTotal", prompt: "Add the two values." };
  const complex = { id: "complex", functionName: "optimizeRoute", prompt: "Find the shortest graph route." };
  const opaque = { id: "opaque", functionName: "mystery", prompt: "Process the input format." };
  assert.equal(taskLane(simple), "simple");
  assert.equal(taskLane(complex), "complex");
  assert.equal(taskLane(opaque), "complex");
  assert.deepEqual(
    planSolverLanes([simple, complex, opaque], config).map((lane) => ({
      id: lane.id,
      model: lane.model,
      ids: lane.tasks.map((task) => task.id),
    })),
    [
      { id: "simple", model: "fast", ids: ["simple"] },
      { id: "complex", model: "strong", ids: ["complex", "opaque"] },
    ],
  );
});

test("one-shot scheduler partitions lanes for concurrent dispatch", () => {
  const tasks = [
    ...Array.from({ length: 5 }, (unused, index) => ({
      id: `simple-${index}`, functionName: "calculateTotal", prompt: "Add the values.",
    })),
    ...Array.from({ length: 3 }, (unused, index) => ({
      id: `complex-${index}`, functionName: "optimizeRoute", prompt: "Find the shortest graph route.",
    })),
  ];
  const lanes = planSolverLanes(tasks, {
    browserStrategy: "one-shot",
    browserSimpleBatchSize: 2,
    browserComplexBatchSize: 2,
    fastModel: "fast",
    fastReasoning: "low",
    strongModel: "strong",
    strongReasoning: "medium",
  });
  assert.deepEqual(lanes.map((lane) => ({ id: lane.id, tasks: lane.tasks.length })), [
    { id: "simple-1", tasks: 2 },
    { id: "simple-2", tasks: 2 },
    { id: "simple-3", tasks: 1 },
    { id: "complex-1", tasks: 2 },
    { id: "complex-2", tasks: 1 },
  ]);
});

test("single-fast strategy keeps the subscription path to one model turn", () => {
  const tasks = [
    { id: "simple", functionName: "calculateTotal", prompt: "Add the values." },
    { id: "complex", functionName: "optimizeRoute", prompt: "Find the shortest graph route." },
  ];
  const lanes = planSolverLanes(tasks, {
    browserStrategy: "single-fast",
    fastModel: "fast",
    fastReasoning: "low",
  });
  assert.deepEqual(lanes.map((lane) => ({ id: lane.id, model: lane.model, ids: lane.tasks.map((task) => task.id) })), [
    { id: "all-fast", model: "fast", ids: ["simple", "complex"] },
  ]);
});

test("browser latency keys distinguish strategy and model settings", () => {
  assert.equal(browserLatencyKey({
    browserStrategy: "single-fast", fastModel: "luna", fastReasoning: "low",
    strongModel: "terra", strongReasoning: "medium",
  }), "single-fast:luna:low:terra:medium");
});

test("browser run identifies the visible pre-start screen before calling a model", async () => {
  const browser = {
    session: "pre-start-test",
    async assertOrigin() {},
    async bridge(operation) {
      assert.equal(operation, "inspect");
      return { cardCount: 0, startButtonCount: 1 };
    },
  };
  await assert.rejects(
    runBrowserBridge({
      browser,
      allowedOrigin: "https://ctf.firecrawl.dev",
      config: { bridgeReserveMs: 12_000, bridgeRepairReserveMs: 12_000 },
      totalDeadlineMs: 60_000,
    }),
    (error) => error.code === "BROWSER_LEVEL_NOT_STARTED",
  );
});
