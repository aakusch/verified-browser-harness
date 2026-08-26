function defaultJavaScript(task) {
  if (task.id === "fixture-sum") {
    return "function solve(numbers) { return numbers.reduce((sum, value) => sum + value, 0); }";
  }
  return `function ${task.functionName || "solve"}() { throw new Error("No mock solution for ${task.id}"); }`;
}

export class MockModelClient {
  constructor(overrides = {}) {
    this.overrides = overrides;
    this.calls = [];
  }

  async structured(request) {
    this.calls.push(request);
    const parsedInput = JSON.parse(request.input);

    if (request.schemaName === "javascript_solutions") {
      return {
        value: {
          solutions: parsedInput.tasks.map((task) => {
            // An override may be a bare code string or a { code, examples } pair.
            const override = this.overrides[task.id];
            const solution = typeof override === "string" ? { code: override } : override;
            return {
              id: task.id,
              code: solution?.code || defaultJavaScript(task),
              examples: solution?.examples || [],
            };
          }),
        },
        responseId: "mock-js",
        usage: null,
      };
    }

    if (request.schemaName === "source_answer") {
      const answer = this.overrides[parsedInput.id] || {
        answer: parsedInput.choices?.[0] || "fixture answer",
        confidence: "high",
        evidence: ["src/math.js:1"],
      };
      return {
        value: { id: parsedInput.id, ...answer },
        responseId: "mock-source",
        usage: null,
      };
    }

    if (request.schemaName === "systems_solution") {
      return {
        value: {
          id: parsedInput.id,
          files: Object.entries(parsedInput.starterFiles).map(([filePath, content]) => ({
            path: filePath,
            content,
          })),
          notes: "Mock solution preserves starter files.",
        },
        responseId: "mock-systems",
        usage: null,
      };
    }

    throw new Error(`Unsupported mock schema ${request.schemaName}`);
  }
}
