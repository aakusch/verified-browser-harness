import { HarnessError } from "../errors.mjs";

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text !== "") {
    return response.output_text;
  }
  return (response.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((content) => content?.type === "output_text")
    .map((content) => content.text)
    .join("");
}

function combineAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class OpenAIModelClient {
  constructor({
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    safetyIdentifier = "cheetcode-v3-local-harness",
    serviceTier = "auto",
    requestTimeoutMs = 45_000,
    maxOutputTokens = 12_000,
    maxAttempts = 2,
    fetchImpl = globalThis.fetch,
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.safetyIdentifier = safetyIdentifier;
    this.serviceTier = serviceTier;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxOutputTokens = maxOutputTokens;
    this.maxAttempts = maxAttempts;
    this.fetchImpl = fetchImpl;
  }

  async structured({
    model,
    reasoningEffort,
    instructions,
    input,
    schema,
    schemaName,
    timeoutMs = this.requestTimeoutMs,
    signal,
  }) {
    if (!this.apiKey) {
      throw new HarnessError(
        "OPENAI_API_KEY is required for the openai provider (or use --provider codex)",
        { code: "MISSING_API_KEY" },
      );
    }

    const requestBody = JSON.stringify({
      model,
      instructions,
      input,
      store: false,
      safety_identifier: this.safetyIdentifier,
      service_tier: this.serviceTier,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: this.maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
        verbosity: "low",
      },
    });
    const endsAt = Date.now() + Math.max(1, Math.min(timeoutMs, this.requestTimeoutMs));

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remainingMs = endsAt - Date.now();
      if (remainingMs <= 0) {
        throw new HarnessError("Model request timed out", { code: "MODEL_TIMEOUT" });
      }
      const timeoutSignal = AbortSignal.timeout(remainingMs);
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal: combineAbortSignals([signal, timeoutSignal]),
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        if (!timedOut && attempt < this.maxAttempts) {
          await wait(Math.min(200 * attempt, Math.max(0, endsAt - Date.now())));
          continue;
        }
        throw new HarnessError(
          timedOut ? "Model request timed out" : `Model request failed: ${error.message}`,
          { code: timedOut ? "MODEL_TIMEOUT" : "MODEL_REQUEST_FAILED", cause: error },
        );
      }

      const raw = await response.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        throw new HarnessError("OpenAI returned a non-JSON response", {
          code: "INVALID_MODEL_RESPONSE",
          cause: error,
          details: { status: response.status },
        });
      }

      if (!response.ok) {
        if (retryableStatus(response.status) && attempt < this.maxAttempts) {
          await wait(Math.min(200 * attempt, Math.max(0, endsAt - Date.now())));
          continue;
        }
        throw new HarnessError(
          payload?.error?.message || `OpenAI request failed with ${response.status}`,
          {
            code: "MODEL_REQUEST_FAILED",
            details: { status: response.status, type: payload?.error?.type },
          },
        );
      }
      if (payload.status !== "completed") {
        throw new HarnessError(`Model response ended with status ${payload.status}`, {
          code: "INCOMPLETE_MODEL_RESPONSE",
          details: { status: payload.status, incomplete: payload.incomplete_details },
        });
      }

      const outputText = extractOutputText(payload);
      try {
        return {
          value: JSON.parse(outputText),
          responseId: payload.id,
          usage: payload.usage || null,
        };
      } catch (error) {
        throw new HarnessError("Structured model output was not valid JSON", {
          code: "INVALID_MODEL_RESPONSE",
          cause: error,
        });
      }
    }

    throw new HarnessError("Model request failed after retries", {
      code: "MODEL_REQUEST_FAILED",
    });
  }
}

export { extractOutputText };
