import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { MockModelClient } from "../src/model/mock.mjs";
import { SolverCache } from "../src/runtime/cache.mjs";
import { solveManifest } from "../src/solver/orchestrator.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("solveManifest completes the JavaScript fixture and reuses cache", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cheetcode-orchestrator-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const manifest = await loadManifest(path.join(root, "fixtures", "javascript.json"));
  const config = loadConfig({ CHEETCODE_CACHE_DIR: temporary }, root);
  const cache = new SolverCache(config.cacheDir);
  const firstClient = new MockModelClient();
  const first = await solveManifest({ manifest, config, cache, client: firstClient });
  assert.equal(first.run.complete, true);
  assert.equal(first.results[0].validation.tests, 3);
  assert.equal(firstClient.calls.length, 1);

  const secondClient = new MockModelClient();
  const second = await solveManifest({ manifest, config, cache, client: secondClient });
  assert.equal(second.run.complete, true);
  assert.equal(second.results[0].source, "cache");
  assert.equal(secondClient.calls.length, 0);
});
