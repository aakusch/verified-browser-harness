import { spawn } from "node:child_process";
import { HarnessError } from "../errors.mjs";
import { pageBridgeOperation } from "./page-adapter.mjs";

function runProcess(command, args, { input = "", timeoutMs = 25_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const abort = () => {
      terminate();
      finish(() => reject(new HarnessError(`${command} was cancelled`, {
        code: "BROWSER_CANCELLED",
      })));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new HarnessError(`${command} timed out`, {
        code: "BROWSER_TIMEOUT",
      })));
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => reject(new HarnessError(`Could not start ${command}: ${error.message}`, {
        code: "BROWSER_COMMAND_FAILED",
        cause: error,
      })));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new HarnessError(
            stderr.trim() || `${command} exited with status ${code}`,
            { code: "BROWSER_COMMAND_FAILED", details: { exitCode: code } },
          ));
          return;
        }
        resolve(stdout);
      });
    });
    child.stdin.end(input);
  });
}

function parseAgentBrowserJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new HarnessError("agent-browser returned invalid JSON", {
      code: "BROWSER_PROTOCOL_ERROR",
      cause: error,
    });
  }
  if (!parsed.success) {
    throw new HarnessError(parsed.error || "agent-browser evaluation failed", {
      code: "BROWSER_EVALUATION_FAILED",
    });
  }
  return parsed.data?.result;
}

// The page bridge cannot throw a typed error across the agent-browser process boundary,
// so it returns this envelope instead and the session turns it back into a HarnessError.
function unwrapPageResult(result) {
  const failure = result?.__harnessError;
  if (!failure) return result;
  throw new HarnessError(failure.message || "Browser page bridge rejected the request", {
    code: failure.code || "BROWSER_EVALUATION_FAILED",
    details: failure.details,
  });
}

/**
 * Serializes every browser command onto one FIFO chain.
 *
 * Why: agent-browser drives a single shared page. Two overlapping writes (fill while a
 * check is being clicked, or a read interleaved with a fill) produce results that do not
 * describe any single page state, and the submit gate then compares hashes against a page
 * that was never coherent. One writer keeps every observation ordered and reproducible.
 */
export class AgentBrowserSession {
  constructor({
    session,
    executable = "agent-browser",
    timeoutMs = 25_000,
    runImpl = runProcess,
  }) {
    if (!session) {
      throw new HarnessError("A browser session name is required", {
        code: "INVALID_BROWSER_SESSION",
      });
    }
    this.session = session;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.runImpl = runImpl;
    this.operationCount = 0;
    this.completedOperations = [];
    this.queue = Promise.resolve();
  }

  /** Runs `task` after every previously enqueued browser operation has settled. */
  serialize(label, task) {
    const enqueued = this.queue.then(task, task);
    // Keep the chain alive after a rejection so one failed operation cannot wedge the run.
    this.queue = enqueued.then(
      () => {
        this.completedOperations.push({ label, ok: true });
      },
      () => {
        this.completedOperations.push({ label, ok: false });
      },
    );
    this.operationCount += 1;
    return enqueued;
  }

  async command(args, options = {}) {
    return this.serialize(args[0] || "command", () => this.runImpl(
      this.executable,
      ["--session", this.session, ...args],
      { timeoutMs: this.timeoutMs, ...options },
    ));
  }

  async evaluateSource(source, timeoutMs = this.timeoutMs, { signal, label = "eval" } = {}) {
    const output = await this.serialize(label, () => this.runImpl(
      this.executable,
      ["--session", this.session, "eval", "--stdin", "--json"],
      { input: source, timeoutMs, signal },
    ));
    return parseAgentBrowserJson(output);
  }

  async location() {
    return this.evaluateSource(
      "({href: location.href, origin: location.origin, title: document.title})",
      this.timeoutMs,
      { label: "location" },
    );
  }

  async assertOrigin(allowedOrigin) {
    const location = await this.location();
    if (location.origin !== allowedOrigin) {
      throw new HarnessError(
        `Browser is at ${location.origin}; expected ${allowedOrigin}`,
        { code: "BROWSER_ORIGIN_MISMATCH" },
      );
    }
    return location;
  }

  async bridge(operation, payload = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
    const source = `(${pageBridgeOperation.toString()})(${JSON.stringify({ operation, ...payload })})`;
    const result = await this.evaluateSource(source, timeoutMs, {
      signal,
      label: `bridge:${operation}`,
    });
    return unwrapPageResult(result);
  }
}

export { parseAgentBrowserJson, runProcess, unwrapPageResult };
