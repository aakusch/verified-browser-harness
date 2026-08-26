import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSourceIndex, retrieveSource } from "../src/source/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("source index retrieves the relevant local excerpt", async () => {
  const index = await buildSourceIndex([
    { name: "fixture", path: path.join(root, "fixtures", "source-repo") },
  ]);
  const chunks = retrieveSource(index, "Which function sums an array?", {
    repository: "fixture",
  });
  assert.equal(chunks[0].path, "src/math.js");
  assert.match(chunks[0].content, /function sum/);
});
