import assert from "node:assert/strict";
import test from "node:test";
import { Deadline, chunk, mapConcurrent } from "../src/runtime/deadline.mjs";

test("Deadline keeps the configured reserve out of the work budget", () => {
  let now = 1_000;
  const deadline = new Deadline(10_000, { reserveMs: 2_000, now: () => now });
  assert.equal(deadline.remainingMs(), 8_000);
  now += 7_500;
  assert.equal(deadline.remainingMs(), 500);
  assert.equal(deadline.remainingMs({ includeReserve: true }), 2_500);
});

test("chunk and mapConcurrent preserve order", async () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(await mapConcurrent([3, 1, 2], 2, async (value) => value * 2), [6, 2, 4]);
});
