import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "../src/manifest.mjs";

test("validateManifest normalizes a JavaScript task", () => {
  const manifest = validateManifest({
    schemaVersion: 1,
    tasks: [{
      id: "one",
      kind: "javascript",
      prompt: "Return one.",
      functionName: "solve",
      tests: [{ args: [], expected: 1 }],
    }],
  }, "/tmp/example/manifest.json");
  assert.equal(manifest.run.deadlineMs, 60_000);
  assert.equal(manifest.tasks[0].tests[0].expected, 1);
});

test("validateManifest rejects duplicate ids", () => {
  assert.throws(() => validateManifest({
    schemaVersion: 1,
    tasks: [
      { id: "same", kind: "source", prompt: "One?" },
      { id: "same", kind: "source", prompt: "Two?" },
    ],
  }), /Duplicate task id/);
});
