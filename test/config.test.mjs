import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

test("loadConfig applies latency-oriented defaults", () => {
  const config = loadConfig({}, "/tmp/cheetcode-config-test");
  assert.equal(config.fastModel, "gpt-5.6-luna");
  assert.equal(config.strongModel, "gpt-5.6-terra");
  assert.equal(config.systemsModel, "gpt-5.6-sol");
  assert.equal(config.fastReasoning, "low");
  assert.equal(config.concurrency, 6);
  assert.equal(config.bridgeReserveMs, 12_000);
  assert.equal(config.serviceTier, "auto");
  assert.equal(config.modelProvider, "openai");
  assert.equal(config.codexBatchSize, 25);
});

test("loadConfig accepts an explicit latency service tier", () => {
  assert.equal(loadConfig({ CHEETCODE_SERVICE_TIER: "priority" }).serviceTier, "priority");
  assert.throws(
    () => loadConfig({ CHEETCODE_SERVICE_TIER: "impossible" }),
    /not supported/,
  );
});

test("loadConfig accepts the subscription-backed Codex provider", () => {
  const config = loadConfig({ CHEETCODE_MODEL_PROVIDER: "codex" });
  assert.equal(config.modelProvider, "codex");
  assert.throws(
    () => loadConfig({ CHEETCODE_MODEL_PROVIDER: "browser-cookie" }),
    /not supported/,
  );
});

test("loadConfig rejects invalid numeric overrides", () => {
  assert.throws(
    () => loadConfig({ CHEETCODE_CONCURRENCY: "0" }),
    /positive integer/,
  );
});
