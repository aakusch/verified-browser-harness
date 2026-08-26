# Orchestration Design

## Control Plane

The browser runner is deliberately deterministic. It owns the state machine,
deadline, task routing, model output aggregation, visible check polling, and
submission gate. Model workers produce structured task answers only; they do
not mutate the browser.

```text
landing -> signed-in -> pre-start -> active -> captured -> solving
        -> filling/checking -> verified -> submitted | stopped
```

`pre-start` is a hard gate. The runner returns `BROWSER_LEVEL_NOT_STARTED`
instead of invoking a model when the visible `Skip and Start` control is present.

## Capture

The page adapter expands each visible task before capture. It collects visible
paragraph content, removes duplicates, and falls back to the card text only when
no paragraph prompt exists. Captures are written under `.cache/browser-runs/`
with private file permissions for local replay and diagnosis.

## Scheduling

`CHEETCODE_BROWSER_STRATEGY=single-fast` is the default for a 60-second level:
one compact Luna batch minimizes subscription CLI startup and queueing overhead.

`one-shot` keeps independent Luna and Terra lanes for levels with enough time.
`repair` also reserves time for visible-check repair. All lanes retain their
completed work even if another lane times out. Browser fills and checks are
serialized through one queue.

## Submission Policy

The runner writes a short-lived verification state only after every visible
check passes. Submission revalidates origin, card count, editor hashes, and
check states. A known partial result is never submitted by the harness.

## Evaluation

Use local fixtures for deterministic regression coverage. Measure real
subscription latency only when the user explicitly requests it, then record the
outcome in `docs/HANDOFF.md` before changing the default schedule.
