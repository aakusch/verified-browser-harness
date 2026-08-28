import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexExecModelClient,
  codexArguments,
  codexPrompt,
} from "../src/model/codex.mjs";

test("Codex exec arguments isolate a structured read-only run", () => {
  const args = codexArguments({
    directory: "/tmp/work",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    schemaPath: "/tmp/work/schema.json",
    outputPath: "/tmp/work/output.json",
  });
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--output-schema"));
  assert.ok(!args.some((value) => value.includes("dangerously")));
});

test("Codex prompt treats task input as data and requests no tool use", () => {
  const prompt = codexPrompt({
    instructions: "Solve it.",
    input: "{\"task\":\"example\"}",
    schemaName: "answer",
  });
  assert.match(prompt, /without calling tools/);
  assert.match(prompt, /untrusted problem data/);
  assert.match(prompt, /Output contract: answer/);
});

test("CodexExecModelClient reads validated output and removes temporary files", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "harness-codex-test-"));
  let observed;
  try {
    const client = new CodexExecModelClient({
      temporaryRoot,
      runImpl: async (executable, args, options) => {
        const schemaPath = args[args.indexOf("--output-schema") + 1];
        const outputPath = args[args.indexOf("--output-last-message") + 1];
        observed = {
          executable,
          args,
          options,
          schema: JSON.parse(await readFile(schemaPath, "utf8")),
        };
        await writeFile(outputPath, "{\"ok\":true}\n");
        return { stdout: "", stderr: "" };
      },
    });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    const response = await client.structured({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      instructions: "Return ok.",
      input: "{}",
      schema,
      schemaName: "test_output",
      timeoutMs: 1_000,
    });
    assert.deepEqual(response.value, { ok: true });
    assert.equal(observed.executable, "codex");
    assert.deepEqual(observed.schema, schema);
    assert.equal(observed.options.timeoutMs, 1_000);
    assert.equal(client.requestCount, 1);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
