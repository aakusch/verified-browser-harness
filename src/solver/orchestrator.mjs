import { HarnessError, asHarnessError } from "../errors.mjs";
import { Deadline, chunk, mapConcurrent } from "../runtime/deadline.mjs";
import { validateJavaScript } from "../runtime/js-validator.mjs";
import { retrieveSource } from "../source/index.mjs";
import {
  javascriptRequest,
  javascriptSchema,
  sourceAnswerSchema,
  sourceRequest,
  systemsRequest,
  systemsSolutionSchema,
} from "./prompts.mjs";

function errorResult(task, error, retained = null) {
  const normalized = asHarnessError(error);
  return {
    id: task.id,
    kind: task.kind,
    status: "failed",
    error: { code: normalized.code, message: normalized.message },
    // Why: a lane that fails late still holds work worth keeping. Dropping the candidate
    // here is what turned one Codex timeout into a run with nothing to type into the page.
    ...(retained || {}),
  };
}

export function taskCacheKey(task, context = null) {
  return { schemaVersion: 1, task, context };
}

// A failed oversized batch is retried as halves while the timer still allows it.
const MAX_BATCH_SPLIT_DEPTH = 3;
const MIN_SPLIT_BUDGET_MS = 2_000;

/**
 * Turns the model's own worked examples into runnable tests.
 *
 * Why: a captured browser card carries no visible tests, so the first fill used to be
 * unvalidated and the page's Run Check was the only oracle. On a 60-second timer there is
 * rarely room for a second round trip, so the cheap local check has to happen before the
 * answer is typed, not after.
 */
export function derivedTests(solution) {
  if (!Array.isArray(solution?.examples)) return [];
  const tests = [];
  for (const example of solution.examples) {
    try {
      const args = JSON.parse(example.argsJson);
      if (!Array.isArray(args)) continue;
      tests.push({ args, expected: JSON.parse(example.expectedJson) });
    } catch {
      // An unparseable example is discarded; it must never fail an otherwise good answer.
    }
  }
  return tests;
}

/**
 * Validates against the task's own visible tests when it has them, and against the
 * model's derived examples when it does not.
 */
async function validateWithFallback(task, code, derived, config) {
  if (task.tests.length > 0) {
    return validateJavaScript(task, code, { timeoutMs: config.validationTimeoutMs });
  }
  if (derived.length === 0) {
    return { ok: true, skipped: true, reason: "No visible tests supplied" };
  }
  const validation = await validateJavaScript(
    { ...task, tests: derived },
    code,
    { timeoutMs: config.validationTimeoutMs },
  );
  // Derived evidence is weaker than a visible test, so it never earns a cache entry.
  return { ...validation, derived: true };
}

function validationFeedback(validation) {
  if (!validation) return "The previous solution did not validate.";
  const prefix = validation.derived
    ? "Your own worked example failed when it was run. "
    : "";
  if (validation.error) return `${prefix}${validation.error.name}: ${validation.error.message}`;
  if (validation.failedTest !== undefined) {
    return prefix + JSON.stringify({
      failedVisibleTest: validation.failedTest + 1,
      expected: validation.expected,
      actual: validation.actual,
    });
  }
  return "The previous solution did not validate.";
}

/** Ranks two failed attempts so the retained answer is the one that got furthest. */
function betterAttempt(left, right) {
  if (!left) return right;
  if (!right) return left;
  const score = (attempt) => {
    if (!attempt.validation) return -1;
    if (attempt.validation.error) return 0;
    return 1 + (attempt.validation.failedTest ?? 0);
  };
  return score(right) > score(left) ? right : left;
}

function inlineContext(task) {
  if (!Array.isArray(task.context)) return [];
  return task.context.map((entry, index) => {
    if (typeof entry === "string") {
      return { repository: "inline", path: `context-${index + 1}`, startLine: 1, content: entry };
    }
    return {
      repository: entry.repository || "inline",
      path: entry.path || `context-${index + 1}`,
      startLine: entry.startLine || 1,
      content: String(entry.content || ""),
    };
  });
}

async function requestJavaScriptBatch(batch, context, { model, reasoningEffort, feedback }) {
  const { client, config, deadline } = context;
  deadline.assertOpen("JavaScript model batch", 500);
  const request = javascriptRequest(batch, feedback);
  return client.structured({
    model,
    reasoningEffort,
    ...request,
    schema: javascriptSchema(batch.map((task) => task.id)),
    schemaName: "javascript_solutions",
    timeoutMs: deadline.timeoutMs(config.requestTimeoutMs),
    signal: deadline.signal,
  });
}

/**
 * Runs one batch, splitting it in half on failure while time remains.
 *
 * Why: the subscription-backed CLI adapters send every task in one process to spend a
 * single turn. Without this, one request that outruns the level timer fails all 25 tasks
 * at once. Splitting converts that cliff into a partial result the run can still use.
 */
async function solveJavaScriptBatch(batch, context, depth = 0) {
  const { deadline, log } = context;
  try {
    const response = await requestJavaScriptBatch(batch, context, {
      model: context.config.fastModel,
      reasoningEffort: context.config.fastReasoning,
    });
    return [{ batch, response }];
  } catch (error) {
    const canSplit =
      batch.length > 1 &&
      depth < MAX_BATCH_SPLIT_DEPTH &&
      deadline.isOpen(MIN_SPLIT_BUDGET_MS);
    if (!canSplit) return [{ batch, error }];
    const half = Math.ceil(batch.length / 2);
    log(
      `javascript: batch of ${batch.length} failed (${asHarnessError(error).code}); ` +
      `retrying as ${half} + ${batch.length - half}`,
    );
    const left = await solveJavaScriptBatch(batch.slice(0, half), context, depth + 1);
    const right = await solveJavaScriptBatch(batch.slice(half), context, depth + 1);
    return [...left, ...right];
  }
}

async function solveJavaScriptTasks(tasks, context) {
  const { cache, config, deadline, log } = context;
  const solved = new Map();
  const pending = [];

  await mapConcurrent(tasks, config.concurrency, async (task) => {
    const cached = await cache.get("solutions", taskCacheKey(task));
    if (cached?.code) {
      const validation = await validateJavaScript(task, cached.code, {
        timeoutMs: config.validationTimeoutMs,
      });
      if (validation.ok) {
        solved.set(task.id, {
          id: task.id,
          kind: task.kind,
          status: "solved",
          code: cached.code,
          validation,
          source: "cache",
        });
        return;
      }
    }
    pending.push(task);
  });

  if (pending.length > 0) {
    log(`javascript: ${pending.length} uncached task(s)`);
    const batches = chunk(pending, config.batchSize);
    const nested = await mapConcurrent(
      batches,
      Math.min(config.concurrency, batches.length),
      async (batch) => solveJavaScriptBatch(batch, context),
    );
    const batchResults = nested.flat();

    for (const batchResult of batchResults) {
      if (batchResult.error) {
        for (const task of batchResult.batch) solved.set(task.id, errorResult(task, batchResult.error));
        continue;
      }
      const byId = new Map(
        (batchResult.response.value.solutions || []).map((solution) => [solution.id, solution]),
      );
      for (const task of batchResult.batch) {
        const solution = byId.get(task.id);
        if (!solution?.code) {
          solved.set(
            task.id,
            errorResult(
              task,
              new HarnessError("Model omitted this task", { code: "MISSING_SOLUTION" }),
            ),
          );
          continue;
        }
        solved.set(task.id, {
          id: task.id,
          kind: task.kind,
          status: "candidate",
          code: solution.code,
          derivedTests: derivedTests(solution),
          model: config.fastModel,
        });
      }
    }
  }

  const candidates = tasks.filter((task) => solved.get(task.id)?.status === "candidate");
  await mapConcurrent(candidates, config.concurrency, async (task) => {
    const result = solved.get(task.id);
    const validation = await validateWithFallback(
      task,
      result.code,
      result.derivedTests || [],
      config,
    );
    if (validation.ok) {
      result.status = "solved";
      result.validation = validation;
      result.source = "model";
      if (!validation.skipped && !validation.derived) {
        await cache.put("solutions", taskCacheKey(task), { code: result.code });
      }
    } else {
      result.status = "invalid";
      result.validation = validation;
    }
  });

  const invalid = tasks.filter((task) => solved.get(task.id)?.status === "invalid");
  if (invalid.length > 0 && deadline.isOpen(1_500)) {
    log(`javascript: repairing ${invalid.length} failed visible-test solution(s)`);
    await mapConcurrent(invalid, config.concurrency, async (task) => {
      const first = solved.get(task.id);
      const firstAttempt = {
        code: first.code,
        validation: first.validation,
        model: first.model,
        source: "model",
      };
      try {
        deadline.assertOpen("JavaScript repair", 750);
        const response = await requestJavaScriptBatch([task], context, {
          model: config.strongModel,
          reasoningEffort: config.strongReasoning,
          feedback: { [task.id]: validationFeedback(first.validation) },
        });
        const repaired = response.value.solutions?.find((solution) => solution.id === task.id);
        const code = repaired?.code;
        if (!code) throw new HarnessError("Repair omitted this task", { code: "MISSING_SOLUTION" });
        const validation = await validateWithFallback(
          task,
          code,
          // Re-check against the union of both attempts' examples.
          [...(first.derivedTests || []), ...derivedTests(repaired)],
          config,
        );
        if (!validation.ok) {
          const repairAttempt = {
            code,
            validation,
            model: config.strongModel,
            source: "repair",
          };
          const retained = betterAttempt(firstAttempt, repairAttempt);
          solved.set(task.id, {
            id: task.id,
            kind: task.kind,
            status: "failed",
            error: {
              code: "VISIBLE_TEST_FAILED",
              message: "Repaired solution still fails visible tests",
            },
            // Code and validation always describe the same attempt.
            code: retained.code,
            validation: retained.validation,
            model: retained.model,
            source: retained.source,
            retained: true,
            attempts: [firstAttempt, repairAttempt],
          });
          return;
        }
        solved.set(task.id, {
          id: task.id,
          kind: task.kind,
          status: "solved",
          code,
          validation,
          model: config.strongModel,
          source: "repair",
          attempts: [firstAttempt],
        });
        if (!validation.skipped && !validation.derived) {
          await cache.put("solutions", taskCacheKey(task), { code });
        }
      } catch (error) {
        solved.set(task.id, errorResult(task, error, {
          code: firstAttempt.code,
          validation: firstAttempt.validation,
          model: firstAttempt.model,
          source: firstAttempt.source,
          retained: true,
          attempts: [firstAttempt],
        }));
      }
    });
  }

  for (const task of tasks) {
    const result = solved.get(task.id);
    if (result?.status === "invalid") {
      solved.set(task.id, {
        ...result,
        status: "failed",
        retained: true,
        error: { code: "VISIBLE_TEST_FAILED", message: "Solution fails visible tests" },
      });
    }
  }
  return solved;
}

async function solveSourceTasks(tasks, context) {
  const { cache, client, config, deadline, sourceIndex, log } = context;
  const solved = new Map();
  log(`source: solving ${tasks.length} question(s)`);

  await mapConcurrent(tasks, config.concurrency, async (task) => {
    try {
      const sourceContextKey = sourceIndex?.key || (task.context ? "inline" : null);
      const cached = await cache.get("solutions", taskCacheKey(task, sourceContextKey));
      if (cached?.answer) {
        solved.set(task.id, {
          id: task.id,
          kind: task.kind,
          status: "solved",
          ...cached,
          source: "cache",
        });
        return;
      }

      deadline.assertOpen("source question", 500);
      let contextChunks = inlineContext(task);
      if (contextChunks.length === 0 && sourceIndex) {
        contextChunks = retrieveSource(sourceIndex, task.prompt, {
          repository: task.repository,
        });
      }
      if (contextChunks.length === 0) {
        throw new HarnessError(`No source context found for ${task.id}`, {
          code: "SOURCE_CONTEXT_MISSING",
        });
      }

      const request = sourceRequest(task, contextChunks);
      const response = await client.structured({
        model: config.fastModel,
        reasoningEffort: config.fastReasoning,
        ...request,
        schema: sourceAnswerSchema,
        schemaName: "source_answer",
        timeoutMs: deadline.timeoutMs(config.requestTimeoutMs),
        signal: deadline.signal,
      });
      const answer = response.value;
      if (answer.id !== task.id || typeof answer.answer !== "string" || !answer.answer) {
        throw new HarnessError("Source answer did not match the requested task", {
          code: "INVALID_MODEL_RESPONSE",
        });
      }
      if (task.choices && !task.choices.includes(answer.answer)) {
        throw new HarnessError("Source answer was not one of the supplied choices", {
          code: "INVALID_MODEL_RESPONSE",
        });
      }
      const value = {
        answer: answer.answer,
        confidence: answer.confidence,
        evidence: answer.evidence,
        model: config.fastModel,
      };
      solved.set(task.id, {
        id: task.id,
        kind: task.kind,
        status: "solved",
        ...value,
        source: "model",
      });
      await cache.put("solutions", taskCacheKey(task, sourceContextKey), value);
    } catch (error) {
      solved.set(task.id, errorResult(task, error));
    }
  });
  return solved;
}

async function solveSystemsTasks(tasks, context) {
  const { cache, client, config, deadline, log } = context;
  const solved = new Map();
  log(`systems: solving ${tasks.length} task(s)`);

  await mapConcurrent(tasks, Math.min(2, config.concurrency), async (task) => {
    try {
      const cached = await cache.get("solutions", taskCacheKey(task));
      if (Array.isArray(cached?.files)) {
        solved.set(task.id, {
          id: task.id,
          kind: task.kind,
          status: "solved",
          ...cached,
          source: "cache",
        });
        return;
      }
      deadline.assertOpen("systems task", 1_000);
      const request = systemsRequest(task);
      const response = await client.structured({
        model: config.systemsModel,
        reasoningEffort: config.systemsReasoning,
        ...request,
        schema: systemsSolutionSchema,
        schemaName: "systems_solution",
        timeoutMs: deadline.timeoutMs(config.requestTimeoutMs),
        signal: deadline.signal,
      });
      const value = response.value;
      if (value.id !== task.id || !Array.isArray(value.files) || value.files.length === 0) {
        throw new HarnessError("Systems solution was incomplete", {
          code: "INVALID_MODEL_RESPONSE",
        });
      }
      const expectedPaths = new Set(Object.keys(task.starterFiles));
      const actualPaths = new Set(value.files.map((file) => file.path));
      for (const expectedPath of expectedPaths) {
        if (!actualPaths.has(expectedPath)) {
          throw new HarnessError(`Systems solution omitted ${expectedPath}`, {
            code: "INVALID_MODEL_RESPONSE",
          });
        }
      }
      const cachedValue = {
        files: value.files,
        notes: value.notes,
        model: config.systemsModel,
      };
      solved.set(task.id, {
        id: task.id,
        kind: task.kind,
        status: "solved",
        ...cachedValue,
        source: "model",
      });
      await cache.put("solutions", taskCacheKey(task), cachedValue);
    } catch (error) {
      solved.set(task.id, errorResult(task, error));
    }
  });
  return solved;
}

export async function solveManifest({
  manifest,
  config,
  client,
  cache,
  sourceIndex = null,
  deadlineMs = manifest.run.deadlineMs,
  log = () => {},
}) {
  const deadline = new Deadline(deadlineMs, { reserveMs: config.reserveMs });
  const context = { manifest, config, client, cache, sourceIndex, deadline, log };
  const maps = [];

  const javascriptTasks = manifest.tasks.filter((task) => task.kind === "javascript");
  const sourceTasks = manifest.tasks.filter((task) => task.kind === "source");
  const systemsTasks = manifest.tasks.filter((task) => task.kind === "systems");

  try {
    if (javascriptTasks.length) maps.push(await solveJavaScriptTasks(javascriptTasks, context));
    if (sourceTasks.length) maps.push(await solveSourceTasks(sourceTasks, context));
    if (systemsTasks.length) maps.push(await solveSystemsTasks(systemsTasks, context));
  } finally {
    // Release the abort timer so a completed run cannot cancel unrelated later work.
    deadline.dispose();
  }

  const byId = new Map(maps.flatMap((map) => [...map.entries()]));
  const results = manifest.tasks.map((task) => byId.get(task.id) || errorResult(
    task,
    new HarnessError("Task was not processed", { code: "TASK_NOT_PROCESSED" }),
  ));
  const solvedCount = results.filter((result) => result.status === "solved").length;
  const failed = results.filter((result) => result.status !== "solved");

  return {
    schemaVersion: 1,
    run: {
      id: manifest.run.id,
      complete: solvedCount === results.length,
      taskCount: results.length,
      solvedCount,
      failedCount: failed.length,
      // Answers kept from a failed lane: still worth typing into the page, where the
      // visible check is the real oracle.
      retainedCount: failed.filter((result) => typeof result.code === "string").length,
      failures: failed.map((result) => ({
        id: result.id,
        code: result.error?.code || "UNKNOWN",
        retained: typeof result.code === "string",
      })),
      elapsedMs: deadline.elapsedMs(),
      remainingMs: deadline.remainingMs({ includeReserve: true }),
    },
    results,
  };
}
