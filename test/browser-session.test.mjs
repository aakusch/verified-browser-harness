import assert from "node:assert/strict";
import test from "node:test";
import { AgentBrowserSession, unwrapPageResult } from "../src/browser/agent-browser.mjs";

function jsonResult(value) {
  return JSON.stringify({ success: true, data: { result: value }, error: null });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("agent-browser eval uses the CLI's documented session/stdin/json flags", async () => {
  const seen = [];
  const session = new AgentBrowserSession({
    session: "harness",
    runImpl: async (executable, args, options) => {
      seen.push({ executable, args, options });
      return jsonResult({ ok: true });
    },
  });
  assert.deepEqual(await session.bridge("inspect", { profile: {} }), { ok: true });
  assert.equal(seen[0].executable, "agent-browser");
  assert.deepEqual(seen[0].args, ["--session", "harness", "eval", "--stdin", "--json"]);
  assert.match(seen[0].options.input, /^\(async function pageBridgeOperation/);
  assert.match(seen[0].options.input, /"operation":"inspect"/);
});

test("browser commands run one at a time in call order", async () => {
  const events = [];
  const session = new AgentBrowserSession({
    session: "harness",
    runImpl: async (executable, args, options) => {
      const label = options.input || args.join(" ");
      events.push(`start:${label}`);
      // The first call is the slowest; without serialization it would finish last.
      await delay(label.includes("first") ? 30 : 1);
      events.push(`end:${label}`);
      return jsonResult(label);
    },
  });

  const results = await Promise.all([
    session.evaluateSource("first"),
    session.evaluateSource("second"),
    session.evaluateSource("third"),
  ]);

  assert.deepEqual(results, ["first", "second", "third"]);
  assert.deepEqual(events, [
    "start:first",
    "end:first",
    "start:second",
    "end:second",
    "start:third",
    "end:third",
  ]);
  assert.equal(session.operationCount, 3);
});

test("one failed browser operation does not wedge the queue", async () => {
  let call = 0;
  const session = new AgentBrowserSession({
    session: "harness",
    runImpl: async () => {
      call += 1;
      if (call === 1) throw new Error("transient agent-browser failure");
      return jsonResult("recovered");
    },
  });
  await assert.rejects(session.evaluateSource("first"), /transient/);
  assert.equal(await session.evaluateSource("second"), "recovered");
  assert.deepEqual(session.completedOperations.map((item) => item.ok), [false, true]);
});

test("page bridge failures cross the process boundary as typed errors", () => {
  assert.deepEqual(unwrapPageResult({ ok: 1 }), { ok: 1 });
  assert.throws(
    () => unwrapPageResult({
      __harnessError: {
        code: "PAGE_NOT_STARTED",
        message: "The level has not started yet.",
        details: { pageState: "not-started" },
      },
    }),
    (error) => error.code === "PAGE_NOT_STARTED" && error.details.pageState === "not-started",
  );
});
