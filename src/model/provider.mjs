import { HarnessError } from "../errors.mjs";
import { CodexExecModelClient } from "./codex.mjs";
import { OpenAIModelClient } from "./openai.mjs";

function resolveModelProvider(value = "openai") {
  if (!["openai", "codex"].includes(value)) {
    throw new HarnessError(`Unsupported model provider: ${value}`, {
      code: "INVALID_ARGUMENT",
    });
  }
  return value;
}

export function createModelRuntime(config, providerOverride) {
  const provider = resolveModelProvider(providerOverride || config.modelProvider);
  if (provider === "openai") {
    return { provider, client: new OpenAIModelClient(config), config };
  }
  return {
    provider,
    client: new CodexExecModelClient({
      executable: config.codexExecutable,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    config: Object.freeze({
      ...config,
      batchSize: config.codexBatchSize,
      concurrency: 1,
    }),
  };
}

export { resolveModelProvider };
