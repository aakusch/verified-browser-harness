import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HarnessError } from "../errors.mjs";

const workerPath = fileURLToPath(new URL("./js-worker.mjs", import.meta.url));

function runWorker(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", "--disable-warning=ExperimentalWarning", workerPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: { name: "TimeoutError", message: "Validation timed out" } });
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(
          new HarnessError("JavaScript validator returned invalid output", {
            code: "VALIDATOR_FAILED",
            cause: error,
            details: { exitCode: code, stderr: stderr.slice(0, 500) },
          }),
        );
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export async function validateJavaScript(task, code, { timeoutMs = 1_500 } = {}) {
  if (task.tests.length === 0) {
    return { ok: true, skipped: true, reason: "No visible tests supplied" };
  }
  const worker = await runWorker(
    {
      code,
      tests: task.tests,
      perTestTimeoutMs: Math.max(20, Math.floor(timeoutMs / task.tests.length)),
    },
    timeoutMs,
  );
  if (!worker.ok) return { ok: false, error: worker.error };

  for (let index = 0; index < task.tests.length; index += 1) {
    if (!isDeepStrictEqual(worker.results[index], task.tests[index].expected)) {
      return {
        ok: false,
        failedTest: index,
        expected: task.tests[index].expected,
        actual: worker.results[index],
      };
    }
  }
  return { ok: true, tests: task.tests.length };
}
