import vm from "node:vm";

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  context.__args = null;
  context.__result = null;

  const definition = new vm.Script(`"use strict"; (${request.code})`, {
    filename: "generated-solution.js",
  });
  const solution = definition.runInContext(context, {
    timeout: request.perTestTimeoutMs,
  });
  if (typeof solution !== "function") {
    throw new TypeError("Solution code must evaluate to a function");
  }
  context.__solution = solution;

  const results = [];
  for (const test of request.tests) {
    context.__args = structuredClone(test.args);
    const invocation = new vm.Script("__result = __solution(...__args)");
    const result = invocation.runInContext(context, {
      timeout: request.perTestTimeoutMs,
    });
    if (result && typeof result.then === "function") {
      context.__result = await result;
    }
    results.push(structuredClone(context.__result));
  }
  write({ ok: true, results });
} catch (error) {
  write({
    ok: false,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
    },
  });
}
