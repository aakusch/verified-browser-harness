# CheetCode v3 solver harness

A local, dependency-free Node.js harness for solving the visible programming and
source-reading tasks in [Firecrawl's CheetCode v3 challenge](https://ctf.firecrawl.dev/).
It optimizes model work around the short level timers without automating login,
probing private endpoints, or extracting hidden answer data.

Tasks can enter through a local JSON manifest or through a visible-DOM browser bridge.
The bridge can fill editors and click each visible **Run Check** button. Final
submission is a separate, explicitly confirmed operation protected by origin, expiry,
editor-hash, card-count, and visible-check gates.

## What it does

- Runs JavaScript problems in parallel batches against a fast model.
- Checks generated functions against visible tests in a permission-restricted child
  process and sends failures through one stronger-model repair pass.
- Indexes user-supplied local source checkouts before the timer begins, retrieves the
  most relevant excerpts per question, and answers source questions concurrently.
- Sends a systems task, starter files, and named checks to a stronger coding model and
  returns complete file contents without executing generated native code.
- Caches successful answers by task content, so repeated problems are effectively free.
- Stops starting expensive work as the configured deadline approaches and preserves a
  2.5-second output reserve by default.
- Discovers visible task cards, fills common web editors, runs visible checks, and
  performs one stronger-model repair pass before it permits final submission.

The harness has two real-model providers. `openai` calls the Responses API directly
with `store: false`, a privacy-preserving safety identifier, and strict JSON-schema
output. `codex` runs one ephemeral, subscription-authenticated `codex exec` process in
a read-only temporary workspace with the same strict schema. The defaults are
`gpt-5.6-luna` for latency-sensitive work, `gpt-5.6-terra` for JavaScript repairs, and
`gpt-5.6-sol` for the single systems task. All are configurable.

## Requirements

- Node.js 22 or newer. The current development runtime is Node 25.
- The `agent-browser` CLI on `PATH` for the browser bridge.
- Either a subscription-authenticated Codex CLI session or `OPENAI_API_KEY` in the
  process environment for a real model solve. Neither is needed for mock preflights or
  to control an already-authenticated browser session.
- Local repository checkouts for source-reading questions, if the manifest does not
  embed its own visible context.

There are no package dependencies and no install step.

## Agent handoff

Project-wide operating rules are in [`AGENTS.md`](AGENTS.md). The current
architecture, verified local workflow, measured subscription latency, and
remaining work are recorded in [`docs/HANDOFF.md`](docs/HANDOFF.md). Claude
Code and Cursor load concise project-specific entry points from `CLAUDE.md` and
`.cursor/rules/` respectively.

## Quick verification

```bash
npm run check
npm test
npm run solve -- fixtures/javascript.json --mock
npm run preflight:browser
npm run preflight:model
npm run preflight:subscription
```

The mock solve command writes `out/fixture-javascript.submission.json`. Mock mode
exists only to exercise the included fixtures; it is not a fallback solver. The browser
preflight starts a local 25-card replica, fills and checks all cards, proves that the
default run does not submit, tests the submission gate, and exercises the repair pass.
It never contacts the challenge. The model preflight also uses the local fixture and
prints a clean skip result when `OPENAI_API_KEY` is absent. The subscription preflight
uses one real `codex exec` turn against the same fixture and therefore consumes some
of the signed-in Codex account's included allowance.

Subscription latency is recorded in `.cache/latency-observations.json` only by an
explicit `preflight:subscription` or a completed real browser run. A real timed browser
run requires at least three samples for the exact strategy/model settings and rejects
the run when their p95 exceeds its solve budget. The current measurements are recorded
in the handoff and are not safe for a 60-second subscription run.

## Browser workflow

The browser session supplies the page authentication, so no Firecrawl API key is
required. Sign in yourself in a dedicated `agent-browser` session; do not give login
credentials to the harness. Once the challenge page is visibly active, inspect its
DOM without filling or clicking anything:

```bash
agent-browser --session cheetcode --headed open https://ctf.firecrawl.dev/
npm run bridge -- inspect \
  --session cheetcode \
  --allow-origin https://ctf.firecrawl.dev
```

`inspect` reports the number of visible cards, editor types, prompt lengths, and
whether a single final-submit button was found. It does not call the model or click a
button. Run the solver only when that output matches the active level:

```bash
npm run bridge -- run \
  --session cheetcode \
  --allow-origin https://ctf.firecrawl.dev \
  --provider codex \
  --deadline-ms 60000
```

The default `run` operation captures visible prompts, calls the model, fills every
editor, runs all visible checks, re-reads every editor, and then stops. Its JSON result
contains a short-lived `verificationToken`; it has not clicked **Finish & Submit**.
Use the actual remaining time for `--deadline-ms` if the page timer is already moving.

To submit that exact verified browser state, use the returned token and state path:

```bash
npm run bridge -- submit \
  --session cheetcode \
  --verification-state .cache/browser-verification/cheetcode.json \
  --verification-token TOKEN_FROM_RUN
```

For a timed run where pausing to copy the token would be too expensive, automatic
submission still requires a conspicuous exact confirmation:

```bash
npm run bridge -- run \
  --session cheetcode \
  --allow-origin https://ctf.firecrawl.dev \
  --provider codex \
  --deadline-ms 60000 \
  --submit-after-verify SUBMIT_VERIFIED_RUN
```

Even in this mode, the final click is blocked unless the browser is still on the exact
allowed origin, the verification is still within the run's timer window, all editor
hashes are unchanged, the card count is unchanged, and every visible check is passing.

The generic adapter finds visible **Run Check** buttons and walks up to the nearest
container with one editor and one check button. It supports textareas, contenteditable
editors, CodeMirror 5/6, and Monaco. If the live page differs, pass `--profile` with a
JSON file overriding selectors and button/status text; test that profile with
`inspect` before consuming an attempt.

On the latest local 25-card browser preflight, capture/fill/check/verification overhead
was 122 ms for a clean solution and 180 ms when one answer needed the repair path.
Those figures exclude model/API latency and do not predict the live site's response
time. The default bridge reserves 8 seconds of a 60-second budget for DOM work,
visible checks, and final verification.

Before capture, the bridge expands visible task details and rejects a pre-start
questionnaire with a specific error instead of consuming a model turn. It schedules
The default `single-fast` strategy sends one compact expanded-prompt Luna batch, which
minimizes subscription CLI startup and queueing overhead. The optional `one-shot`
strategy separates direct tasks from graph, parsing, optimization, validation, and
generic `input` tasks into Luna and Terra lanes. Completed batches are filled and
checked immediately. Set `CHEETCODE_BROWSER_STRATEGY=repair` to reserve a repair phase.

For an explicitly accepted best-effort subscription attempt, `fanout-fast` partitions
all cards into uniform Luna-low batches and starts them through the configured browser
worker pool. It may still queue server-side under a subscription;
use it only with a deliberate latency-gate override:

```bash
CHEETCODE_BROWSER_STRATEGY=fanout-fast \
CHEETCODE_BROWSER_WORKER_CONCURRENCY=8 \
CHEETCODE_BROWSER_SIMPLE_BATCH_SIZE=8 \
npm run bridge -- run --session cheetcode --allow-origin https://ctf.firecrawl.dev \
  --start-level START_LEVEL --override-latency-gate OVERRIDE_LATENCY_GATE
```

## Manifest workflow

Create one manifest for the active level. The harness supports three task kinds and
can technically mix them, though one kind per run matches the challenge flow.

### JavaScript

```json
{
  "schemaVersion": 1,
  "run": { "id": "level-1-attempt-1", "deadlineMs": 60000 },
  "tasks": [
    {
      "id": "problem-1",
      "kind": "javascript",
      "prompt": "Return the sum of the input array.",
      "functionName": "solve",
      "starterCode": "function solve(values) {}",
      "tests": [
        { "args": [[1, 2, 3]], "expected": 6 }
      ]
    }
  ]
}
```

Each generated `code` value is a single function expression or declaration. Visible
tests should use an `args` array because the validator invokes the function as
`solution(...args)`.

### Source questions

Index local checkouts before starting the timed level:

```json
{
  "schemaVersion": 1,
  "run": { "id": "level-2-attempt-1", "deadlineMs": 60000 },
  "sourceRoots": [
    { "name": "project-a", "path": "../project-a" },
    { "name": "project-b", "path": "../project-b" }
  ],
  "tasks": [
    {
      "id": "question-1",
      "kind": "source",
      "repository": "project-a",
      "prompt": "Which module owns retry scheduling?",
      "choices": ["scheduler", "worker", "transport"]
    }
  ]
}
```

```bash
npm run index -- level-2.json
npm run solve -- level-2.json
```

The index contains source text and is stored under `.cache/` with mode `0600`; it is
ignored by git. Retrieved excerpts are sent to the configured model, so do not point
the harness at confidential repositories unless that data is approved for the API.
For a self-contained question, provide `context` entries directly on the task instead
of `sourceRoots`.

### Systems task

```json
{
  "schemaVersion": 1,
  "run": { "id": "level-3-attempt-1", "deadlineMs": 120000 },
  "tasks": [
    {
      "id": "systems-1",
      "kind": "systems",
      "language": "rust",
      "prompt": "Full visible specification here.",
      "starterFiles": {
        "src/lib.rs": "pub fn todo() {}\n"
      },
      "checks": ["check names visible in the challenge"]
    }
  ]
}
```

Generate a report, inspect it, then materialize its files into a new directory:

```bash
npm run solve -- level-3.json
npm run materialize -- out/level-3-attempt-1.submission.json ./level-3-worktree
```

Materialization rejects absolute paths and `..` traversal. The harness deliberately
does not compile or execute generated C, C++, or Rust; use the challenge's normal
validation flow after reviewing the files.

## CLI

```text
npm run index -- <manifest.json> [--force]
npm run solve -- <manifest.json> [--out <file|->] [--deadline-ms <ms>]
    [--provider <openai|codex>] [--mock]
npm run materialize -- <submission.json> <output-directory>
npm run bridge -- inspect|capture|run|submit <options>
```

`--deadline-ms` is useful when the manifest is created after the visible timer has
already started. Source-index preparation occurs before the solver's internal deadline
starts. Logs contain task counts and IDs, not the API key.

Useful environment overrides:

```text
CHEETCODE_FAST_MODEL
CHEETCODE_STRONG_MODEL
CHEETCODE_SYSTEMS_MODEL
CHEETCODE_MODEL_PROVIDER
CHEETCODE_CODEX_EXECUTABLE
CHEETCODE_CODEX_BATCH_SIZE
CHEETCODE_FAST_REASONING
CHEETCODE_STRONG_REASONING
CHEETCODE_SYSTEMS_REASONING
CHEETCODE_SERVICE_TIER
CHEETCODE_CONCURRENCY
CHEETCODE_BATCH_SIZE
CHEETCODE_RESERVE_MS
CHEETCODE_REQUEST_TIMEOUT_MS
CHEETCODE_VALIDATION_TIMEOUT_MS
CHEETCODE_CACHE_DIR
CHEETCODE_SAFETY_IDENTIFIER
CHEETCODE_BRIDGE_RESERVE_MS
CHEETCODE_BRIDGE_REPAIR_RESERVE_MS
CHEETCODE_BRIDGE_CHECK_TIMEOUT_MS
CHEETCODE_BRIDGE_POLL_MS
CHEETCODE_BRIDGE_VERIFICATION_TTL_MS
CHEETCODE_BROWSER_WORKER_CONCURRENCY
CHEETCODE_BROWSER_SIMPLE_BATCH_SIZE
CHEETCODE_BROWSER_COMPLEX_BATCH_SIZE
CHEETCODE_BROWSER_STRATEGY
```

`CHEETCODE_SERVICE_TIER=priority` can request lower-latency API processing when the
API project supports it and may have different billing. It applies only to the
`openai` provider; the default is `auto`. The default model provider is `codex`, which
uses the signed-in Codex subscription. Select API billing explicitly with
`--provider openai` or `CHEETCODE_MODEL_PROVIDER=openai`.

The API shape and model defaults follow the current
[OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
and [model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Scope and limitations

- The harness only knows what is present in the manifest or local source index.
- Visible tests improve reliability but do not prove correctness against hidden checks.
- The Node permission model plus a `vm` context and hard timeout reduce risk while
  checking generated JavaScript; they are not a general-purpose security sandbox.
- Native systems output is generated but never executed automatically.
- Nothing in this project logs into Firecrawl, bypasses access controls, inspects
  hidden data, or calls private challenge endpoints. Page interaction is limited to
  visible controls in the user-opened browser session.
- Final submission is possible only through the separately gated `submit` command or
  the exact `SUBMIT_VERIFIED_RUN` confirmation on `run`.
