export function javascriptSchema(taskIds) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      solutions: {
        type: "array",
        minItems: taskIds.length,
        maxItems: taskIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: taskIds },
            code: { type: "string" },
          },
          required: ["id", "code"],
        },
      },
    },
    required: ["solutions"],
  };
}

export const sourceAnswerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    answer: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
    },
  },
  required: ["id", "answer", "confidence", "evidence"],
};

export const systemsSolutionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    notes: { type: "string" },
  },
  required: ["id", "files", "notes"],
};

export function javascriptRequest(tasks, feedback = {}) {
  return {
    instructions: [
      "Solve each independent JavaScript programming task.",
      "Return exactly one solution per requested id.",
      "Each code value must be a single JavaScript function expression or declaration that evaluates to the requested function.",
      "Do not use imports, require, process, filesystem, network, timers, eval, or Function.",
      "Favor direct deterministic implementations and account for edge cases described by the prompt and visible tests.",
      "Return only the structured result.",
    ].join(" "),
    input: JSON.stringify({
      tasks: tasks.map((task) => ({
        id: task.id,
        prompt: task.prompt,
        functionName: task.functionName,
        starterCode: task.starterCode || "",
        visibleTests: task.tests,
        previousFailure: feedback[task.id] || null,
      })),
    }),
  };
}

export function sourceRequest(task, context) {
  return {
    instructions: [
      "Answer the source-code question using only the supplied context.",
      "When choices are present, copy the chosen choice exactly as the answer.",
      "Cite concise file:line evidence from the supplied excerpts.",
      "If context is incomplete, make the best supported choice and lower confidence instead of inventing evidence.",
      "Return only the structured result.",
    ].join(" "),
    input: JSON.stringify({
      id: task.id,
      question: task.prompt,
      choices: task.choices || [],
      repository: task.repository || null,
      context,
    }),
  };
}

export function systemsRequest(task) {
  return {
    instructions: [
      "Implement the requested systems-programming task completely.",
      "Return the full final content of every file that must be created or changed.",
      "Preserve required public APIs and filenames from the starter files.",
      "Treat check names as requirements, but do not claim checks were run.",
      "Do not add network access, shell execution, credential access, or unrelated behavior.",
      "Return only the structured result.",
    ].join(" "),
    input: JSON.stringify({
      id: task.id,
      language: task.language,
      prompt: task.prompt,
      starterFiles: task.starterFiles,
      checks: task.checks || [],
    }),
  };
}
