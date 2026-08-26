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
- Asks the model for 2-4 worked examples alongside each solution and runs them locally
  before anything is typed into the page, so a captured card with no visible tests is
  still validated on the first pass rather than by a Run Check round trip.
- Indexes user-supplied local source checkouts before the timer begins, retrieves the
  most relevant excerpts per question, and answers source questions concurrently.
- Sends a systems task, starter files, and named checks to a stronger coding model and
  returns complete file contents without executing generated native code.
- Caches successful answers by task content, so repeated problems are effectively free.
- Stops starting expensive work as the configured deadline approaches and preserves a
  2.5-second output reserve by default.
- Discovers visible task cards, expands their collapsed details, fills common web
  editors, runs visible checks, and performs one stronger-model repair pass before it
  permits final submission.
- Keeps whatever a failed lane already produced, and refuses to prepare a submission
  unless every visible check on every card is passing.

The harness has four real-model providers. `openai` calls the Responses API directly
with `store: false`, a privacy-preserving safety identifier, and strict JSON-schema
output. `codex` runs one ephemeral, subscription-authenticated `codex exec` process in
a read-only temporary workspace with the same strict schema. `claude` and `cursor` run
the Claude Code and Cursor CLIs the same way, for operators who are signed into those
instead; neither CLI enforces an output schema, so their replies are validated locally
before use and a violation fails only that lane. Codex stays the recommended CLI backend
because it is the only one that enforces the contract at the source. The defaults are
`gpt-5.6-luna` for latency-sensitive work, `gpt-5.6-terra` for JavaScript repairs, and
`gpt-5.6-sol` for the single systems task. All are configurable.

## Requirements

- Node.js 22 or newer. The current development runtime is Node 25.
- The `agent-browser` CLI on `PATH` for the browser bridge.
- Either a subscription-authenticated agent CLI session (`codex`, and optionally
  `claude` or `cursor-agent`) or `OPENAI_API_KEY` in the process environment for a real
  model solve. Neither is needed for mock preflights or to control an
  already-authenticated browser session.
- Local repository checkouts for source-reading questions, if the manifest does not
  embed its own visible context.

There are no package dependencies and no install step.

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
preflight starts a local 25-card replica, asserts that the pre-start screen and the entry
questionnaire are detected by name, proves that capture expands each card's collapsed
details and captures the prompt once, fills and checks all cards, proves that the default
run does not submit, tests the submission gate, exercises the repair pass, and shows a
partially failed lane keeping its 24 answers with no submission token.
It never contacts the challenge. The model preflight also uses the local fixture and
prints a clean skip result when `OPENAI_API_KEY` is absent. The subscription preflight
uses one real `codex exec` turn against the same fixture and therefore consumes some
of the signed-in Codex account's included allowance.

The last recorded subscription preflight solved and locally validated all 25 synthetic
tasks in one GPT-5.6 Luna turn in 19.6 seconds. Added to the 115 ms clean browser
preflight measured on the current code, the local end-to-end path is about 19.7 seconds.
This is encouraging but not a guarantee of live model or challenge-site latency, and the
subscription figure has not been re-measured since the changes above.

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

`inspect` reports the page state, the number of visible cards, editor types, prompt
lengths, how many collapsed regions each card still hides, and whether a single
final-submit button was found. It does not call the model, click a button, or expand
anything. When no solvable card is present it names why: `not-started` for a level behind
a start control, `questionnaire` for an entry form, `unknown` otherwise. `capture` and
`run` refuse those pages with `PAGE_NOT_STARTED` or `QUESTIONNAIRE_PRESENT` instead of a
selector error; press start or answer the form yourself, then re-run.

`capture` expands every collapsed region in each card first, so the model receives the
constraints that live behind a "show details" toggle. The captured prompt is assembled
from the card's visible text nodes, which keeps it complete without repeating the same
sentence once per matching selector. Run the solver only when `inspect` matches the
active level:

```bash
npm run bridge -- run \
  --session cheetcode \
  --allow-origin https://ctf.firecrawl.dev \
  --provider codex \
  --deadline-ms 60000
```

### Reviewing question types

To study what a level actually asks — for tuning prompts or a selector profile — point the
read-only review command at a session you have already opened and started yourself:

```bash
npm run review -- --session cheetcode --out review/
```

It writes a full-page `page.png`, the raw `inspect.json`, and a `questions.md` digest of
every visible card's title, prompt, starter code, and check state. It only screenshots and
reads the DOM: it never opens a page, starts a level, expands a card, fills an editor,
clicks **Run Check**, or submits. Run it just after you start a level or once a run has
finished — not mid-run, since it is a second process competing for the same browser
session.

The default `run` operation captures visible prompts, calls the model, fills every
editor, runs all visible checks, re-reads every editor, and then stops. Its JSON result
contains a short-lived `verificationToken`; it has not clicked **Finish & Submit**.
Use the actual remaining time for `--deadline-ms` if the page timer is already moving.

A `run` that cannot finish everything no longer throws away what it did finish. If the
model lane loses some tasks to the timer, the harness still fills and checks the answers
it has, reports `complete: false` with a `diagnostics` array, exits non-zero, and writes
**no** verification state — so there is nothing for `submit` to act on. A single oversized
CLI batch that exceeds the timer is retried as halves while time remains, which turns an
all-or-nothing failure into a partial result. Answers kept from a failed lane are still
typed into the page, because the visible check is the only oracle that counts.

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

Even in this mode, the final click is blocked unless the run reported `complete: true`,
the browser is still on the exact allowed origin, the verification is still within the
run's timer window, all editor hashes are unchanged, the card count is unchanged, and
every visible check is passing. The page bridge re-checks the visible statuses one last
time inside the browser and refuses to click if any of them is not green.

The generic adapter finds visible **Run Check** buttons and walks up to the nearest
container with one editor and one check button. It supports textareas, contenteditable
editors, CodeMirror 5/6, and Monaco. If the live page differs, pass `--profile` with a
JSON file overriding any of `cardSelector`, `editorSelector`, `titleSelector`,
`promptSelector`, `promptExcludeSelector`, `checkStatusSelector`, `questionnaireSelector`,
`checkButtonText`, `submitButtonText`, `expandTogglePattern`, `startButtonPattern`,
`passPattern`, `failPattern`, or `pendingPattern`; test that profile with `inspect`
before consuming an attempt.

On the latest local 25-card browser preflight, capture/fill/check/verification overhead
was 115 ms for a clean solution (capture 12 ms, fill 35 ms, all 25 visible checks settled
by 101 ms) and 102 ms for a run that lost one task to a simulated model timeout and
stopped without a submission token. Those figures exclude model/API latency and do not
predict the live site's response time. The default bridge reserves 12 seconds of a
60-second budget for DOM work, visible checks, and final verification.

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

Every solution also carries 2-4 model-derived `examples` (`argsJson` / `expectedJson`
strings, so the contract stays inside strict-schema mode). When a task has real visible
tests those win; when it has none — which is every card the browser bridge captures —
the derived examples are run in the same sandbox before the fill, and a failure triggers
the repair pass early instead of after a visible check. Derived evidence is deliberately
weaker than a visible test: it never populates the answer cache, and an unparseable
example is discarded rather than failing an otherwise good answer.

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
    [--provider <openai|codex|claude|cursor>] [--mock]
npm run materialize -- <submission.json> <output-directory>
npm run bridge -- inspect|capture|run|submit <options>
npm run review -- --session <name> [--out <directory>] [--allow-origin <origin>]
```

Every browser operation is queued onto one serialized writer, so no read ever observes a
page that is halfway through a fill or a check click.

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
CHEETCODE_CLAUDE_EXECUTABLE
CHEETCODE_CURSOR_EXECUTABLE
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
CHEETCODE_BRIDGE_CHECK_TIMEOUT_MS
CHEETCODE_BRIDGE_POLL_MS
CHEETCODE_BRIDGE_VERIFICATION_TTL_MS
```

`CHEETCODE_SERVICE_TIER=priority` can request lower-latency API processing when the
API project supports it and may have different billing. It applies only to the
`openai` provider; the default is `auto`. The default model provider is also `openai`,
so select the subscription path explicitly with `--provider codex` or
`CHEETCODE_MODEL_PROVIDER=codex`.

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
