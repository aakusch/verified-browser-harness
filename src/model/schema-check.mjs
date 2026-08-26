import { HarnessError } from "../errors.mjs";

/**
 * Validates a model response against the JSON Schema subset this harness emits.
 *
 * Why: only the OpenAI provider enforces the schema server-side. The CLI-backed adapters
 * (Codex, Claude Code, Cursor) hand back whatever JSON the agent wrote, so an unchecked
 * response surfaces later as a confusing `undefined` deep inside the orchestrator instead
 * of one clear INVALID_MODEL_RESPONSE for that lane.
 */
function check(value, schema, path, problems) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    for (const required of schema.required || []) {
      if (!(required in value)) problems.push(`${path}.${required} is missing`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) problems.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) check(value[key], childSchema, `${path}.${key}`, problems);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path} needs at least ${schema.minItems} item(s), received ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path} allows at most ${schema.maxItems} item(s), received ${value.length}`);
    }
    value.forEach((item, index) => check(item, schema.items, `${path}[${index}]`, problems));
    return;
  }

  if (schema.type === "string" && typeof value !== "string") {
    problems.push(`${path} must be a string`);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    problems.push(`${path} must be a boolean`);
    return;
  }
  if ((schema.type === "number" || schema.type === "integer") && typeof value !== "number") {
    problems.push(`${path} must be a number`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of the declared values`);
  }
}

export function validateStructuredValue(value, schema, schemaName = "structured output") {
  const problems = [];
  check(value, schema, "value", problems);
  if (problems.length > 0) {
    throw new HarnessError(
      `Model response does not satisfy ${schemaName}: ${problems.slice(0, 5).join("; ")}`,
      { code: "INVALID_MODEL_RESPONSE", details: { problems } },
    );
  }
  return value;
}
