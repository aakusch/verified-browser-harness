import { HarnessError } from "../errors.mjs";
import { AgentCliModelClient } from "./agent-cli.mjs";
import { CodexExecModelClient } from "./codex.mjs";
import { OpenAIModelClient } from "./openai.mjs";

const MODEL_PROVIDERS = Object.freeze(["openai", "codex", "claude", "cursor"]);

function resolveModelProvider(value = "openai") {
  if (!MODEL_PROVIDERS.includes(value)) {
    throw new HarnessError(
      `Unsupported model provider: ${value}. Supported: ${MODEL_PROVIDERS.join(", ")}`,
      { code: "INVALID_ARGUMENT" },
    );
  }
  return value;
}

export function createModelRuntime(config, providerOverride) {
  const provider = resolveModelProvider(providerOverride || config.modelProvider);
  if (provider === "openai") {
    return { provider, client: new OpenAIModelClient(config), config };
  }
  // Every CLI-backed agent bills one subscription turn per process, so they all run a
  // single serialized request with one large batch instead of parallel fan-out.
  const cliConfig = Object.freeze({
    ...config,
    batchSize: config.codexBatchSize,
    concurrency: 1,
  });
  if (provider === "codex") {
    return {
      provider,
      client: new CodexExecModelClient({
        executable: config.codexExecutable,
        requestTimeoutMs: config.requestTimeoutMs,
      }),
      config: cliConfig,
    };
  }
  return {
    provider,
    client: new AgentCliModelClient({
      agent: provider,
      executable: provider === "claude" ? config.claudeExecutable : config.cursorExecutable,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    config: cliConfig,
  };
}

export { MODEL_PROVIDERS, resolveModelProvider };
