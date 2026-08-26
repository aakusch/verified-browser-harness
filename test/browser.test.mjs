import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentBrowserJson } from "../src/browser/agent-browser.mjs";
import {
  defaultVerificationPath,
  parseArguments,
  validateAutoSubmit,
} from "../src/browser/cli.mjs";
import { codeHash } from "../src/browser/runner.mjs";

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
