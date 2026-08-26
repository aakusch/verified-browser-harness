import path from "node:path";
import { HarnessError } from "./errors.mjs";

const DEFAULTS = Object.freeze({
  fastModel: "gpt-5.6-luna",
  strongModel: "gpt-5.6-terra",
  systemsModel: "gpt-5.6-sol",
  fastReasoning: "low",
  strongReasoning: "medium",
  systemsReasoning: "high",
  concurrency: 6,
  batchSize: 5,
  reserveMs: 2_500,
  requestTimeoutMs: 45_000,
  validationTimeoutMs: 1_500,
  maxOutputTokens: 12_000,
  codexBatchSize: 25,
  bridgeReserveMs: 12_000,
  bridgeCheckTimeoutMs: 8_000,
  bridgePollMs: 100,
  bridgeVerificationTtlMs: 300_000,
});

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HarnessError(`${name} must be a positive integer`, {
      code: "INVALID_CONFIG",
    });
  }
  return parsed;
}

function reasoningEffort(value, fallback, name) {
  const resolved = value || fallback;
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(resolved)) {
    throw new HarnessError(`${name} is not a supported reasoning effort`, {
      code: "INVALID_CONFIG",
    });
  }
  return resolved;
}

function serviceTier(value) {
  const resolved = value || "auto";
  if (!["auto", "default", "flex", "fast", "priority", "ultrafast"].includes(resolved)) {
    throw new HarnessError("CHEETCODE_SERVICE_TIER is not supported", {
      code: "INVALID_CONFIG",
    });
  }
  return resolved;
}

const MODEL_PROVIDERS = Object.freeze(["openai", "codex", "claude", "cursor"]);

function modelProvider(value) {
  const resolved = value || "openai";
  if (!MODEL_PROVIDERS.includes(resolved)) {
    throw new HarnessError(
      `CHEETCODE_MODEL_PROVIDER is not supported. Supported: ${MODEL_PROVIDERS.join(", ")}`,
      { code: "INVALID_CONFIG" },
    );
  }
  return resolved;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  return Object.freeze({
    apiKey: env.OPENAI_API_KEY || "",
    baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    safetyIdentifier:
      env.CHEETCODE_SAFETY_IDENTIFIER || "cheetcode-v3-local-harness",
    serviceTier: serviceTier(env.CHEETCODE_SERVICE_TIER),
    modelProvider: modelProvider(env.CHEETCODE_MODEL_PROVIDER),
    codexExecutable: env.CHEETCODE_CODEX_EXECUTABLE || "codex",
    claudeExecutable: env.CHEETCODE_CLAUDE_EXECUTABLE || "claude",
    cursorExecutable: env.CHEETCODE_CURSOR_EXECUTABLE || "cursor-agent",
    fastModel: env.CHEETCODE_FAST_MODEL || DEFAULTS.fastModel,
    strongModel: env.CHEETCODE_STRONG_MODEL || DEFAULTS.strongModel,
    systemsModel: env.CHEETCODE_SYSTEMS_MODEL || DEFAULTS.systemsModel,
    fastReasoning: reasoningEffort(
      env.CHEETCODE_FAST_REASONING,
      DEFAULTS.fastReasoning,
      "CHEETCODE_FAST_REASONING",
    ),
    strongReasoning: reasoningEffort(
      env.CHEETCODE_STRONG_REASONING,
      DEFAULTS.strongReasoning,
      "CHEETCODE_STRONG_REASONING",
    ),
    systemsReasoning: reasoningEffort(
      env.CHEETCODE_SYSTEMS_REASONING,
      DEFAULTS.systemsReasoning,
      "CHEETCODE_SYSTEMS_REASONING",
    ),
    concurrency: positiveInteger(
      env.CHEETCODE_CONCURRENCY,
      DEFAULTS.concurrency,
      "CHEETCODE_CONCURRENCY",
    ),
    batchSize: positiveInteger(
      env.CHEETCODE_BATCH_SIZE,
      DEFAULTS.batchSize,
      "CHEETCODE_BATCH_SIZE",
    ),
    reserveMs: positiveInteger(
      env.CHEETCODE_RESERVE_MS,
      DEFAULTS.reserveMs,
      "CHEETCODE_RESERVE_MS",
    ),
    requestTimeoutMs: positiveInteger(
      env.CHEETCODE_REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
      "CHEETCODE_REQUEST_TIMEOUT_MS",
    ),
    validationTimeoutMs: positiveInteger(
      env.CHEETCODE_VALIDATION_TIMEOUT_MS,
      DEFAULTS.validationTimeoutMs,
      "CHEETCODE_VALIDATION_TIMEOUT_MS",
    ),
    maxOutputTokens: positiveInteger(
      env.CHEETCODE_MAX_OUTPUT_TOKENS,
      DEFAULTS.maxOutputTokens,
      "CHEETCODE_MAX_OUTPUT_TOKENS",
    ),
    codexBatchSize: positiveInteger(
      env.CHEETCODE_CODEX_BATCH_SIZE,
      DEFAULTS.codexBatchSize,
      "CHEETCODE_CODEX_BATCH_SIZE",
    ),
    bridgeReserveMs: positiveInteger(
      env.CHEETCODE_BRIDGE_RESERVE_MS,
      DEFAULTS.bridgeReserveMs,
      "CHEETCODE_BRIDGE_RESERVE_MS",
    ),
    bridgeCheckTimeoutMs: positiveInteger(
      env.CHEETCODE_BRIDGE_CHECK_TIMEOUT_MS,
      DEFAULTS.bridgeCheckTimeoutMs,
      "CHEETCODE_BRIDGE_CHECK_TIMEOUT_MS",
    ),
    bridgePollMs: positiveInteger(
      env.CHEETCODE_BRIDGE_POLL_MS,
      DEFAULTS.bridgePollMs,
      "CHEETCODE_BRIDGE_POLL_MS",
    ),
    bridgeVerificationTtlMs: positiveInteger(
      env.CHEETCODE_BRIDGE_VERIFICATION_TTL_MS,
      DEFAULTS.bridgeVerificationTtlMs,
      "CHEETCODE_BRIDGE_VERIFICATION_TTL_MS",
    ),
    cacheDir: path.resolve(cwd, env.CHEETCODE_CACHE_DIR || ".cache"),
  });
}

export { DEFAULTS, MODEL_PROVIDERS };
