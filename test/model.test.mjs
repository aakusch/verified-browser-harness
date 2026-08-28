import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIModelClient, extractOutputText } from "../src/model/openai.mjs";

test("extractOutputText handles raw Responses API output", () => {
  assert.equal(extractOutputText({
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
  }), "{\"ok\":true}");
});

test("OpenAIModelClient sends a non-stored strict structured request", async () => {
  let requestBody;
  const client = new OpenAIModelClient({
    apiKey: "test-key",
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return new Response(JSON.stringify({
        id: "response-1",
        status: "completed",
        output_text: "{\"ok\":true}",
      }), { status: 200 });
    },
  });
  const response = await client.structured({
    model: "test-model",
    reasoningEffort: "low",
    instructions: "Test",
    input: "{}",
    schemaName: "test_output",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  });
  assert.deepEqual(response.value, { ok: true });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.safety_identifier, "harness-v3-local-harness");
  assert.equal(requestBody.service_tier, "auto");
});

test("OpenAIModelClient retries a transient response within the same deadline", async () => {
  let calls = 0;
  const client = new OpenAIModelClient({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "try again" } }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify({
        id: "response-2",
        status: "completed",
        output_text: "{\"ok\":true}",
      }), { status: 200 });
    },
  });
  const response = await client.structured({
    model: "test-model",
    reasoningEffort: "low",
    instructions: "Test",
    input: "{}",
    schemaName: "test_output",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    timeoutMs: 2_000,
  });
  assert.deepEqual(response.value, { ok: true });
  assert.equal(calls, 2);
});
