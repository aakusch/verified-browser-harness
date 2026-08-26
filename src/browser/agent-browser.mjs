import { spawn } from "node:child_process";
import { HarnessError } from "../errors.mjs";
import { pageBridgeOperation } from "./page-adapter.mjs";

function runProcess(command, args, { input = "", timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new HarnessError(`${command} timed out`, { code: "BROWSER_TIMEOUT" }));
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
        reject(new HarnessError(`Could not start ${command}: ${error.message}`, {
          code: "BROWSER_COMMAND_FAILED",
          cause: error,
        }));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new HarnessError(
          stderr.trim() || `${command} exited with status ${code}`,
          { code: "BROWSER_COMMAND_FAILED", details: { exitCode: code } },
        ));
        return;
      }
      resolve(stdout);
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

export class AgentBrowserSession {
  constructor({ session, executable = "agent-browser", timeoutMs = 25_000 }) {
    if (!session) {
      throw new HarnessError("A browser session name is required", {
        code: "INVALID_BROWSER_SESSION",
      });
    }
    this.session = session;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
  }

  async command(args, options = {}) {
    return runProcess(
      this.executable,
      ["--session", this.session, ...args],
      { timeoutMs: this.timeoutMs, ...options },
    );
  }

  async evaluateSource(source, timeoutMs = this.timeoutMs) {
    const output = await this.command(["--json", "eval", "--stdin"], {
      input: source,
      timeoutMs,
    });
    return parseAgentBrowserJson(output);
  }

  async location() {
    return this.evaluateSource("({href: location.href, origin: location.origin, title: document.title})");
  }

  async clickVisible(control) {
    return this.command(["click", control]);
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

  async bridge(operation, payload = {}, timeoutMs = this.timeoutMs) {
    const source = `(${pageBridgeOperation.toString()})(${JSON.stringify({ operation, ...payload })})`;
    return this.evaluateSource(source, timeoutMs);
  }
}

export { parseAgentBrowserJson, runProcess };
