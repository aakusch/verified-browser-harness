import { readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "./errors.mjs";

const TASK_KINDS = new Set(["javascript", "source", "systems"]);

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HarnessError(`${label} must be a non-empty string`, {
      code: "INVALID_MANIFEST",
    });
  }
  return value;
}

function normalizeTest(test, taskId, index) {
  if (!test || typeof test !== "object" || !Array.isArray(test.args)) {
    throw new HarnessError(
      `Task ${taskId} test ${index + 1} must contain an args array`,
      { code: "INVALID_MANIFEST" },
    );
  }
  if (!("expected" in test)) {
    throw new HarnessError(
      `Task ${taskId} test ${index + 1} must contain expected`,
      { code: "INVALID_MANIFEST" },
    );
  }
  return { args: test.args, expected: test.expected };
}

function normalizeTask(task, index) {
  if (!task || typeof task !== "object") {
    throw new HarnessError(`Task ${index + 1} must be an object`, {
      code: "INVALID_MANIFEST",
    });
  }
  const id = requireString(task.id, `tasks[${index}].id`);
  const kind = requireString(task.kind, `tasks[${index}].kind`);
  if (!TASK_KINDS.has(kind)) {
    throw new HarnessError(`Task ${id} has unsupported kind ${kind}`, {
      code: "INVALID_MANIFEST",
    });
  }

  const normalized = {
    ...task,
    id,
    kind,
    prompt: requireString(
      task.prompt ?? task.question,
      `Task ${id} prompt`,
    ),
  };

  if (kind === "javascript") {
    normalized.functionName = requireString(
      task.functionName,
      `Task ${id} functionName`,
    );
    normalized.tests = (task.tests || []).map((test, testIndex) =>
      normalizeTest(test, id, testIndex),
    );
  }

  if (kind === "source" && task.choices !== undefined) {
    if (!Array.isArray(task.choices) || task.choices.length < 2) {
      throw new HarnessError(`Task ${id} choices must contain at least two items`, {
        code: "INVALID_MANIFEST",
      });
    }
    normalized.choices = task.choices.map((choice, choiceIndex) =>
      requireString(choice, `Task ${id} choice ${choiceIndex + 1}`),
    );
  }

  if (kind === "systems") {
    normalized.language = requireString(task.language, `Task ${id} language`);
    if (!task.starterFiles || typeof task.starterFiles !== "object") {
      throw new HarnessError(`Task ${id} must contain starterFiles`, {
        code: "INVALID_MANIFEST",
      });
    }
  }

  return normalized;
}

export function validateManifest(value, manifestPath = "manifest.json") {
  if (!value || typeof value !== "object") {
    throw new HarnessError("Manifest must be a JSON object", {
      code: "INVALID_MANIFEST",
    });
  }
  if (value.schemaVersion !== 1) {
    throw new HarnessError("Manifest schemaVersion must be 1", {
      code: "INVALID_MANIFEST",
    });
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new HarnessError("Manifest tasks must be a non-empty array", {
      code: "INVALID_MANIFEST",
    });
  }

  const tasks = value.tasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new HarnessError(`Duplicate task id: ${task.id}`, {
        code: "INVALID_MANIFEST",
      });
    }
    ids.add(task.id);
  }

  const root = path.dirname(path.resolve(manifestPath));
  const sourceRoots = (value.sourceRoots || []).map((source, index) => {
    if (!source || typeof source !== "object") {
      throw new HarnessError(`sourceRoots[${index}] must be an object`, {
        code: "INVALID_MANIFEST",
      });
    }
    return {
      name: requireString(source.name, `sourceRoots[${index}].name`),
      path: path.resolve(root, requireString(source.path, `sourceRoots[${index}].path`)),
    };
  });
  if (new Set(sourceRoots.map((source) => source.name)).size !== sourceRoots.length) {
    throw new HarnessError("sourceRoots names must be unique", {
      code: "INVALID_MANIFEST",
    });
  }

  const deadlineMs = value.run?.deadlineMs ?? 60_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new HarnessError("run.deadlineMs must be a positive integer", {
      code: "INVALID_MANIFEST",
    });
  }

  return {
    ...value,
    schemaVersion: 1,
    run: {
      id: value.run?.id || path.basename(manifestPath, path.extname(manifestPath)),
      deadlineMs,
    },
    sourceRoots,
    tasks,
    manifestPath: path.resolve(manifestPath),
  };
}

export async function loadManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HarnessError(`Manifest is not valid JSON: ${error.message}`, {
        code: "INVALID_MANIFEST",
        cause: error,
      });
    }
    throw error;
  }
  return validateManifest(parsed, manifestPath);
}
