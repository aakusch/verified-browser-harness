import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { CodexExecModelClient } from "../src/model/codex.mjs";
import { createModelRuntime, resolveModelProvider } from "../src/model/provider.mjs";

test("Codex provider uses one subscription-oriented 25-task batch", () => {
  const runtime = createModelRuntime(loadConfig({
    VBH_MODEL_PROVIDER: "codex",
  }, "/tmp/harness-provider-test"));
  assert.equal(runtime.provider, "codex");
  assert.ok(runtime.client instanceof CodexExecModelClient);
  assert.equal(runtime.config.batchSize, 25);
  assert.equal(runtime.config.concurrency, 1);
});

test("model provider rejects unknown backends", () => {
  assert.equal(resolveModelProvider("openai"), "openai");
  assert.throws(() => resolveModelProvider("cookie"), /Unsupported model provider/);
});
