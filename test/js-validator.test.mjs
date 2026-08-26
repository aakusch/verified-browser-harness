import assert from "node:assert/strict";
import test from "node:test";
import { validateJavaScript } from "../src/runtime/js-validator.mjs";

const task = {
  tests: [
    { args: [[1, 2, 3]], expected: 6 },
    { args: [[]], expected: 0 },
  ],
};

test("validateJavaScript accepts a correct function", async () => {
  const result = await validateJavaScript(
    task,
    "function solve(values) { return values.reduce((sum, value) => sum + value, 0); }",
  );
  assert.deepEqual(result, { ok: true, tests: 2 });
});

test("validateJavaScript reports a visible-test mismatch", async () => {
  const result = await validateJavaScript(task, "function solve() { return 0; }");
  assert.equal(result.ok, false);
  assert.equal(result.failedTest, 0);
  assert.equal(result.actual, 0);
});

test("validateJavaScript terminates runaway code", async () => {
  const result = await validateJavaScript(
    { tests: [{ args: [], expected: 1 }] },
    "function solve() { while (true) {} }",
    { timeoutMs: 150 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /timed out/i);
});
