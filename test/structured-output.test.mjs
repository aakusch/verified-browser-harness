import assert from "node:assert/strict";
import test from "node:test";
import { AgentCliModelClient, extractJsonValue } from "../src/model/agent-cli.mjs";
import { validateStructuredValue } from "../src/model/schema-check.mjs";
import { javascriptSchema } from "../src/solver/prompts.mjs";
import { createModelRuntime } from "../src/model/provider.mjs";
import { loadConfig } from "../src/config.mjs";

test("structured validation accepts a well-formed batch answer", () => {
  const schema = javascriptSchema(["a", "b"]);
  const example = { argsJson: "[1]", expectedJson: "2" };
  const value = {
    solutions: [
      { id: "a", code: "x", examples: [example, example] },
      { id: "b", code: "y", examples: [example, example] },
    ],
  };
  assert.deepEqual(validateStructuredValue(value, schema, "javascript_solutions"), value);
});

test("structured validation names what a malformed answer is missing", () => {
  const schema = javascriptSchema(["a", "b"]);
  assert.throws(
    () => validateStructuredValue({ solutions: [{ id: "a" }] }, schema, "javascript_solutions"),
    (error) => {
      assert.equal(error.code, "INVALID_MODEL_RESPONSE");
      assert.ok(error.details.problems.some((problem) => problem.includes("code is missing")));
      assert.ok(error.details.problems.some((problem) => problem.includes("at least 2")));
      return true;
    },
  );
  assert.throws(
    () => validateStructuredValue(
      { solutions: [{ id: "c", code: "x" }, { id: "b", code: "y" }] },
      schema,
      "javascript_solutions",
    ),
    (error) => error.details.problems.some((problem) => problem.includes("declared values")),
  );
});

test("agent CLI replies survive prose and code fences", () => {
  assert.deepEqual(extractJsonValue("{\"a\":1}"), { a: 1 });
  assert.deepEqual(
    extractJsonValue("Here you go:\n```json\n{\"a\": {\"b\": [1,2]}}\n```\nHope that helps."),
    { a: { b: [1, 2] } },
  );
  // A brace inside a string must not close the value early.
  assert.deepEqual(extractJsonValue("{\"code\":\"function f() { return 1; }\"}"), {
    code: "function f() { return 1; }",
  });
  assert.throws(() => extractJsonValue("no json here"), (error) =>
    error.code === "INVALID_MODEL_RESPONSE");
});

test("the Claude Code adapter reads its JSON envelope and validates the schema", async () => {
  const seen = [];
  const client = new AgentCliModelClient({
    agent: "claude",
    runImpl: async (executable, args, options) => {
      seen.push({ executable, args, options });
      return {
        stdout: JSON.stringify({
          type: "result",
          result: "```json\n{\"solutions\":[{\"id\":\"a\",\"code\":\"function a() {}\","
            + "\"examples\":[{\"argsJson\":\"[1]\",\"expectedJson\":\"2\"},"
            + "{\"argsJson\":\"[2]\",\"expectedJson\":\"4\"}]}]}\n```",
        }),
        stderr: "",
      };
    },
  });
  const response = await client.structured({
    model: "claude-opus-5",
    instructions: "Solve it.",
    input: "{}",
    schema: javascriptSchema(["a"]),
    schemaName: "javascript_solutions",
    timeoutMs: 1_000,
  });

  assert.equal(response.value.solutions[0].code, "function a() {}");
  assert.equal(response.value.solutions[0].examples.length, 2);
  assert.equal(seen[0].executable, "claude");
  assert.deepEqual(seen[0].args, ["-p", "--output-format", "json", "--model", "claude-opus-5"]);
  // The problem text goes over stdin, never into the process arguments.
  assert.ok(seen[0].args.every((argument) => !argument.includes("Solve it")));
  assert.match(seen[0].options.input, /reply with one JSON value/);
});

test("a schema-violating agent reply fails that lane instead of leaking undefined", async () => {
  const client = new AgentCliModelClient({
    agent: "cursor",
    runImpl: async () => ({ stdout: "{\"solutions\":[{\"id\":\"a\"}]}", stderr: "" }),
  });
  await assert.rejects(
    client.structured({
      model: "auto",
      instructions: "Solve it.",
      input: "{}",
      schema: javascriptSchema(["a"]),
      schemaName: "javascript_solutions",
    }),
    (error) => error.code === "INVALID_MODEL_RESPONSE",
  );
});

test("every CLI-backed provider runs one serialized batch", () => {
  const config = loadConfig({}, process.cwd());
  for (const provider of ["codex", "claude", "cursor"]) {
    const runtime = createModelRuntime(config, provider);
    assert.equal(runtime.provider, provider);
    assert.equal(runtime.config.concurrency, 1);
    assert.equal(runtime.config.batchSize, config.codexBatchSize);
  }
  assert.equal(createModelRuntime(config, "openai").config.concurrency, config.concurrency);
});
