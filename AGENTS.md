# CheetCode Harness Operating Contract

Read `docs/HANDOFF.md` before changing the harness or running a challenge.

## Safety boundary

- Never open, start, check, or submit a live challenge unless the user explicitly authorizes that action in the current conversation.
- Treat final submission as a separately authorized external action unless the user explicitly authorizes automatic submission.
- Never automate GitHub sign-in, MFA, or credential entry. The user signs in manually in the headed `agent-browser` session.
- Use only visible page content and visible controls. Do not call private endpoints, inspect hidden application state, or extract challenge data from network traffic.

## Working model

- Default provider: subscription-backed `codex`; do not silently switch to API billing.
- The browser is shared mutable state. Only the browser runner writes editors, clicks checks, or submits.
- Keep model outputs structured and task-scoped. Keep routing, deadlines, aggregation, and submission gates deterministic in code.
- Start from a measurable single-request baseline. Add parallel model calls only when recorded latency shows the account can sustain them.
- Run `npm run check`, `npm test`, and `npm run preflight:browser` after harness changes. The browser preflight is local-only.

## Handoff

- Current design, measured subscription timings, and next engineering work are in `docs/HANDOFF.md`.
- Browser orchestration details are in `docs/ORCHESTRATION.md`.
- Do not rerun paid subscription benchmarks unless the user asks; the latest measurements are already recorded.
