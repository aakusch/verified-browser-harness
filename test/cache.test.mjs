import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SolverCache, fingerprint } from "../src/runtime/cache.mjs";

test("fingerprint is stable across object key order", () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});

test("SolverCache writes private JSON and reads it back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new SolverCache(root);
  const file = await cache.put("test", { id: "one" }, { answer: 42 });
  assert.deepEqual(await cache.get("test", { id: "one" }), { answer: 42 });
  assert.equal(JSON.parse(await readFile(file, "utf8")).answer, 42);
});
