import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { HarnessError } from "../src/errors.mjs";
import { validateManifest } from "../src/manifest.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";
import { Deadline } from "../src/runtime/deadline.mjs";
import { derivedTests, solveManifest } from "../src/solver/orchestrator.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A card as the browser bridge captures it: a prompt, a starter, and no visible tests. */
function capturedManifest(deadlineMs) {
  return validateManifest({
    schemaVersion: 1,
    run: { id: "captured", deadlineMs },
    tasks: [{
      id: "problem-01",
      kind: "javascript",
      prompt: "Return double the input.",
      functionName: "double",
      starterCode: "function double(value) {}",
      tests: [],
    }],
  }, path.join(root, "captured.json"));
}

const DOUBLE_EXAMPLES = [
  { argsJson: "[2]", expectedJson: "4" },
  { argsJson: "[0]", expectedJson: "0" },
];

function manifestWith(taskCount, deadlineMs) {
  return validateManifest({
    schemaVersion: 1,
    run: { id: "resilience", deadlineMs },
    tasks: Array.from({ length: taskCount }, (unused, index) => ({
      id: `task-${index + 1}`,
      kind: "javascript",
      prompt: "Return double the input.",
      functionName: "double",
      starterCode: "function double(value) {}",
      tests: [{ args: [2], expected: 4 }],
    })),
  }, path.join(root, "resilience.json"));
}

async function context(t, env = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-resilience-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return {
    config: loadConfig({ VBH_CACHE_DIR: temporary, ...env }, root),
    cache: new SolverCache(path.join(temporary, "solutions")),
  };
}

test("a deadline cancels an in-flight model call and the run still returns", async (t) => {
  const { config, cache } = await context(t, { VBH_RESERVE_MS: "100" });
  let aborted = 0;
  const client = {
    structured: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted += 1;
        reject(new HarnessError("Model request was aborted", { code: "MODEL_TIMEOUT" }));
      }, { once: true });
    }),
  };

  const startedAt = Date.now();
  const report = await solveManifest({
    manifest: manifestWith(2, 900),
    config,
    client,
    cache,
    deadlineMs: 900,
  });

  assert.equal(aborted, 1);
  assert.ok(Date.now() - startedAt < 3_000, "the run must not outlive its own deadline");
  assert.equal(report.run.complete, false);
  assert.equal(report.run.solvedCount, 0);
  assert.equal(report.run.failedCount, 2);
  assert.deepEqual(
    report.results.map((result) => result.error.code),
    ["MODEL_TIMEOUT", "MODEL_TIMEOUT"],
  );
});

test("work that cannot finish inside the timer is never started", async (t) => {
  const { config, cache } = await context(t, { VBH_RESERVE_MS: "100" });
  let calls = 0;
  const client = {
    structured: async () => {
      calls += 1;
      throw new Error("should not be reached");
    },
  };

  const report = await solveManifest({
    manifest: manifestWith(2, 300),
    config,
    client,
    cache,
    deadlineMs: 300,
  });

  assert.equal(calls, 0);
  assert.deepEqual(
    report.results.map((result) => result.error.code),
    ["DEADLINE_EXPIRED", "DEADLINE_EXPIRED"],
  );
});

test("one oversized batch that fails is retried as halves", async (t) => {
  const { config, cache } = await context(t, { VBH_BATCH_SIZE: "8", VBH_CONCURRENCY: "1" });
  const batches = [];
  const client = {
    structured: async (request) => {
      const parsed = JSON.parse(request.input);
      const ids = parsed.tasks.map((task) => task.id);
      batches.push(ids);
      if (ids.includes("task-5")) {
        throw new HarnessError("Codex model request timed out", { code: "MODEL_TIMEOUT" });
      }
      return {
        value: {
          solutions: parsed.tasks.map((task) => ({
            id: task.id,
            code: "function double(value) { return value * 2; }",
          })),
        },
        responseId: "split",
        usage: null,
      };
    },
  };

  const report = await solveManifest({
    manifest: manifestWith(8, 30_000),
    config,
    client,
    cache,
    deadlineMs: 30_000,
  });

  assert.deepEqual(batches[0].length, 8);
  assert.ok(batches.length >= 4, "the failing batch should have been split");
  assert.equal(report.run.solvedCount, 7);
  assert.equal(report.run.failedCount, 1);
  assert.deepEqual(report.run.failures, [
    { id: "task-5", code: "MODEL_TIMEOUT", retained: false },
  ]);
});

test("a failed repair keeps the earlier candidate instead of discarding it", async (t) => {
  const { config, cache } = await context(t);
  const client = {
    structured: async (request) => {
      const parsed = JSON.parse(request.input);
      if (parsed.tasks[0].previousFailure) {
        throw new HarnessError("Repair timed out", { code: "MODEL_TIMEOUT" });
      }
      return {
        value: {
          solutions: [{ id: parsed.tasks[0].id, code: "function double(value) { return value; }" }],
        },
        responseId: "first",
        usage: null,
      };
    },
  };

  const report = await solveManifest({
    manifest: manifestWith(1, 30_000),
    config,
    client,
    cache,
    deadlineMs: 30_000,
  });

  const [result] = report.results;
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MODEL_TIMEOUT");
  assert.equal(result.retained, true);
  assert.equal(result.code, "function double(value) { return value; }");
  assert.equal(result.validation.failedTest, 0);
  assert.equal(report.run.retainedCount, 1);
});

test("when both attempts fail the retained code and validation describe the same attempt", async (t) => {
  const { config, cache } = await context(t);
  const client = {
    structured: async (request) => {
      const parsed = JSON.parse(request.input);
      const repair = Boolean(parsed.tasks[0].previousFailure);
      return {
        value: {
          solutions: [{
            id: parsed.tasks[0].id,
            // The repair throws at runtime; the first attempt merely returns the wrong value.
            code: repair
              ? "function double() { throw new Error('worse'); }"
              : "function double(value) { return value; }",
          }],
        },
        responseId: repair ? "repair" : "first",
        usage: null,
      };
    },
  };

  const report = await solveManifest({
    manifest: manifestWith(1, 30_000),
    config,
    client,
    cache,
    deadlineMs: 30_000,
  });

  const [result] = report.results;
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "VISIBLE_TEST_FAILED");
  assert.equal(result.code, "function double(value) { return value; }");
  assert.equal(result.validation.actual, 2);
  assert.equal(result.attempts.length, 2);
});

test("a disposed deadline stops aborting later work", () => {
  const deadline = new Deadline(50);
  deadline.dispose();
  assert.equal(deadline.signal.aborted, false);
  deadline.abort("explicit");
  assert.equal(deadline.signal.aborted, true);
});

test("worked examples are parsed and bad ones are discarded, never fatal", () => {
  assert.deepEqual(
    derivedTests({ examples: [{ argsJson: "[1,2]", expectedJson: "{\"a\":3}" }] }),
    [{ args: [1, 2], expected: { a: 3 } }],
  );
  // Not an array of arguments, unparseable, and absent: all ignored.
  assert.deepEqual(derivedTests({ examples: [{ argsJson: "5", expectedJson: "5" }] }), []);
  assert.deepEqual(derivedTests({ examples: [{ argsJson: "[", expectedJson: "1" }] }), []);
  assert.deepEqual(derivedTests({}), []);
});

test("a captured card with no visible tests is still checked before it is filled", async (t) => {
  const { config, cache } = await context(t);
  const client = {
    structured: async (request) => {
      const parsed = JSON.parse(request.input);
      assert.deepEqual(parsed.tasks[0].visibleTests, []);
      return {
        value: {
          solutions: [{
            id: parsed.tasks[0].id,
            code: "function double(value) { return value * 2; }",
            examples: DOUBLE_EXAMPLES,
          }],
        },
        responseId: "self-check",
        usage: null,
      };
    },
  };

  const report = await solveManifest({
    manifest: capturedManifest(30_000),
    config,
    client,
    cache,
    deadlineMs: 30_000,
  });

  const [result] = report.results;
  assert.equal(result.status, "solved");
  assert.equal(result.validation.derived, true);
  assert.equal(result.validation.tests, 2);
});

test("a wrong answer is repaired before the browser round trip, not after it", async (t) => {
  const { config, cache } = await context(t);
  const prompts = [];
  const client = {
    structured: async (request) => {
      const parsed = JSON.parse(request.input);
      const task = parsed.tasks[0];
      prompts.push(task.previousFailure);
      return {
        value: {
          solutions: [{
            id: task.id,
            code: task.previousFailure
              ? "function double(value) { return value * 2; }"
              : "function double(value) { return value + 2; }",
            examples: DOUBLE_EXAMPLES,
          }],
        },
        responseId: "repair",
        usage: null,
      };
    },
  };

  const report = await solveManifest({
    manifest: capturedManifest(30_000),
    config,
    client,
    cache,
    deadlineMs: 30_000,
  });

  const [result] = report.results;
  assert.equal(result.status, "solved");
  assert.equal(result.source, "repair");
  assert.equal(result.code, "function double(value) { return value * 2; }");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /own worked example failed/);
});

test("derived evidence alone never populates the cache", async (t) => {
  const { config, cache } = await context(t);
  let calls = 0;
  const client = {
    structured: async (request) => {
      calls += 1;
      return {
        value: {
          solutions: [{
            id: JSON.parse(request.input).tasks[0].id,
            code: "function double(value) { return value * 2; }",
            examples: DOUBLE_EXAMPLES,
          }],
        },
        responseId: "cache",
        usage: null,
      };
    },
  };

  const manifest = capturedManifest(30_000);
  await solveManifest({ manifest, config, client, cache, deadlineMs: 30_000 });
  await solveManifest({ manifest, config, client, cache, deadlineMs: 30_000 });
  // The page's own Run Check is the only thing that earns a cached answer.
  assert.equal(calls, 2);
});
