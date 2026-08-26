# Handoff

## Current state

- `agent-browser 0.35.0` and Chrome for Testing are installed locally.
- Codex CLI is authenticated with ChatGPT and is the default provider.
- The local browser preflight passes, including a forced repair cycle.
- The project has no package dependencies.

## Live observations

Two Level 1 attempts were made against the visible challenge UI.

| Attempt | Result | Learning |
|---|---|---|
| One 25-task Luna batch | Submitted partial: 12 visible passes, 13 failures | One subscription request can sometimes return within the level window, but low reasoning was weak on complex tasks and no repair time remained. |
| Split Luna/Terra lanes | Stopped without submitting: 10 visible passes, 15 unresolved | Simple Luna tasks passed. Four concurrent Terra calls did not produce complex answers before the initial cutoff. |
| Six-lane Luna fan-out | Level ended partial: 6/25 solved, score 240; no submission | The run captured 25 cards and dispatched six subscription processes (8, 4, 4, 4, 4, 1 tasks). The page proves partial completion, but the failed run had no durable lane-result trace. |

## Offline subscription measurements

These commands used the captured visible Level 1 prompt data and did not touch
the live challenge. Do not repeat them without explicit user authorization.

| Run | Outcome |
|---|---|
| Terra low, 15 complex tasks | Timed out at 57.6 seconds, 0 answers |
| Terra medium, 15 complex tasks | Timed out at 57.5 seconds, 0 answers |
| Luna low, 25 expanded tasks | Returned 25 answers in 61.5 seconds |
| Luna low, compact 25-task prompt | Returned 25 answers in 66.2 seconds |

The subscription CLI currently has tail latency that makes a 60-second level
unreliable. The `single-fast` default is the least risky observed strategy, not
a guarantee of completing a live level.

## Files to read first

1. `AGENTS.md`
2. `docs/ORCHESTRATION.md`
3. `src/browser/runner.mjs`
4. `src/browser/page-adapter.mjs`
5. `scripts/browser-preflight.mjs`

## Safe verification

```bash
npm run check
npm test
npm run preflight:browser
```

The preflight uses only the local 25-card replica. Do not run
`npm run preflight:subscription` unless the user explicitly approves consuming
subscription allowance.

## Resumed engineering work

- A persistent `.cache/latency-observations.json` store now records explicit
  subscription preflights and successful real browser runs. A real browser run
  requires at least three observations for the exact strategy/model settings,
  and rejects the strategy when its p95 exceeds the solve budget. Mock and
  local preflight runs are deliberately exempt.
- The local browser replica now covers the visible pre-start gate and task
  details revealed by **Expand**. Capture is asserted to use the revealed
  prompt rather than preview/status/editor card text.
- The adapter prefers explicit `[data-task-prompt]` nodes and no longer uses a
  full-card text fallback, which avoided leaking editor/check chrome into the
  compact model prompt.
- `fanout-fast` now uses uniform 8-task Luna-low batches regardless of the
  heuristic classification. This reduces the last live shape from six
  subscription processes to four for a 25-card level. Each run now persists a
  private per-lane event trace beside its capture, including starts, completed
  solve counts, and failures.

The recorded historical subscription timings above imply that the current
60-second subscription strategy will be rejected until new, explicitly
authorized measurements demonstrate a safe p95. Do not rerun paid benchmarks
unless the user asks.
- Reconsider a latency-guaranteed API provider only if the user authorizes a
  departure from the subscription-backed Codex requirement.
