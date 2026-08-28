import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseArguments, resolveContainedPath } from "../src/cli.mjs";

test("parseArguments separates flags and positional values", () => {
  assert.deepEqual(
    parseArguments(["solve", "run.json", "--mock", "--deadline-ms", "5000"]),
    {
      command: "solve",
      positional: ["run.json"],
      options: { mock: true, "deadline-ms": "5000" },
    },
  );
});

test("resolveContainedPath rejects generated path traversal", () => {
  const root = path.resolve("/tmp/harness-output");
  assert.equal(resolveContainedPath(root, "src/lib.rs"), path.join(root, "src/lib.rs"));
  assert.throws(() => resolveContainedPath(root, "../../outside"), /escapes output/);
  assert.throws(() => resolveContainedPath(root, "/tmp/outside"), /Unsafe generated path/);
  assert.throws(() => resolveContainedPath(root, "."), /Unsafe generated path/);
});
