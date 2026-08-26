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

function errorResult(task, error) {
  const normalized = asHarnessError(error);
  return {
    id: task.id,
    kind: task.kind,
    status: "failed",
    error: { code: normalized.code, message: normalized.message },
  };
}

export function taskCacheKey(task, context = null) {
  return { schemaVersion: 1, task, context };
}

function validationFeedback(validation) {
  if (validation.error) return `${validation.error.name}: ${validation.error.message}`;
  if (validation.failedTest !== undefined) {
    return JSON.stringify({
      failedVisibleTest: validation.failedTest + 1,
      expected: validation.expected,
      actual: validation.actual,
    });
  }
  return "The previous solution did not validate.";
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

async function solveJavaScriptTasks(tasks, context) {
  const { cache, client, config, deadline, log } = context;
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
    const batchResults = await mapConcurrent(
      batches,
      Math.min(config.concurrency, batches.length),
      async (batch) => {
        try {
          deadline.assertOpen("JavaScript model batch", 500);
          const request = javascriptRequest(batch);
          const response = await client.structured({
            model: config.fastModel,
            reasoningEffort: config.fastReasoning,
            ...request,
            schema: javascriptSchema(batch.map((task) => task.id)),
            schemaName: "javascript_solutions",
            timeoutMs: deadline.timeoutMs(config.requestTimeoutMs),
          });
          return { batch, response };
        } catch (error) {
          return { batch, error };
        }
      },
    );

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
          model: config.fastModel,
        });
      }
    }
  }

  const candidates = tasks.filter((task) => solved.get(task.id)?.status === "candidate");
  await mapConcurrent(candidates, config.concurrency, async (task) => {
    const result = solved.get(task.id);
    const validation = await validateJavaScript(task, result.code, {
      timeoutMs: config.validationTimeoutMs,
    });
    if (validation.ok) {
      result.status = "solved";
      result.validation = validation;
      result.source = "model";
      if (!validation.skipped) {
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
      try {
        deadline.assertOpen("JavaScript repair", 750);
        const request = javascriptRequest([task], {
          [task.id]: validationFeedback(first.validation),
        });
        const response = await client.structured({
          model: config.strongModel,
          reasoningEffort: config.strongReasoning,
          ...request,
          schema: javascriptSchema([task.id]),
          schemaName: "javascript_solutions",
          timeoutMs: deadline.timeoutMs(config.requestTimeoutMs),
        });
        const code = response.value.solutions?.find((solution) => solution.id === task.id)?.code;
        if (!code) throw new HarnessError("Repair omitted this task", { code: "MISSING_SOLUTION" });
        const validation = await validateJavaScript(task, code, {
          timeoutMs: config.validationTimeoutMs,
        });
        if (!validation.ok) {
          solved.set(task.id, {
            ...first,
            status: "failed",
            error: {
              code: "VISIBLE_TEST_FAILED",
              message: "Repaired solution still fails visible tests",
            },
            validation,
          });
          return;
        }
        const result = {
          id: task.id,
          kind: task.kind,
          status: "solved",
          code,
          validation,
          model: config.strongModel,
          source: "repair",
        };
        solved.set(task.id, result);
        if (!validation.skipped) {
          await cache.put("solutions", taskCacheKey(task), { code });
        }
      } catch (error) {
        solved.set(task.id, errorResult(task, error));
      }
    });
  }

  for (const task of tasks) {
    const result = solved.get(task.id);
    if (result?.status === "invalid") {
      solved.set(task.id, {
        ...result,
        status: "failed",
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

  if (javascriptTasks.length) maps.push(await solveJavaScriptTasks(javascriptTasks, context));
  if (sourceTasks.length) maps.push(await solveSourceTasks(sourceTasks, context));
  if (systemsTasks.length) maps.push(await solveSystemsTasks(systemsTasks, context));

  const byId = new Map(maps.flatMap((map) => [...map.entries()]));
  const results = manifest.tasks.map((task) => byId.get(task.id) || errorResult(
    task,
    new HarnessError("Task was not processed", { code: "TASK_NOT_PROCESSED" }),
  ));
  const solvedCount = results.filter((result) => result.status === "solved").length;

  return {
    schemaVersion: 1,
    run: {
      id: manifest.run.id,
      complete: solvedCount === results.length,
      taskCount: results.length,
      solvedCount,
      elapsedMs: deadline.elapsedMs(),
      remainingMs: deadline.remainingMs({ includeReserve: true }),
    },
    results,
  };
}
