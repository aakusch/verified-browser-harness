# verified-browser-harness

A local, dependency-free Node.js harness that drives model-generated work into a live
web page — and refuses to submit it until every visible check on that page passes.

The problem it solves: an agent that fills a form and clicks submit is trusting its own
output. This harness treats the page's own validation as the only oracle that counts. It
fills the editors, runs the checks the page provides, re-reads what it typed, and gates
the final irreversible click behind origin, expiry, content-hash, element-count, and
visible-status verification. If any check is not green, there is no token, and nothing
is submitted.

It was built against a timed programming challenge — see [Origin](#origin) — which is
why time budgeting and partial-result recovery are first-class rather than afterthoughts.

## What it gives you

**A verification-gated browser bridge.** Discovers task cards on a page, expands their
collapsed regions, fills the editor in each, runs the visible check, and reports status.
The generic adapter walks from any visible check button up to the nearest container
holding one editor, and supports textareas, contenteditable, CodeMirror 5, CodeMirror 6,
and Monaco. Any site that differs is handled with a `--profile` JSON file overriding the
selectors, with no code change.

**A model provider abstraction.** Four backends behind one contract: the OpenAI Responses
API with strict JSON-schema output, and the `codex`, `claude`, and `cursor` CLIs run as
ephemeral subscription-authenticated processes in read-only temporary workspaces. The CLIs
do not enforce an output schema, so their replies are validated locally and a violation
fails only that lane.

**A deadline scheduler.** Work stops starting as the configured deadline approaches, and
an output reserve is held back so results can always be written. A batch too large to
finish in the remaining time is retried as halves. A run that loses some work to the
timer keeps everything it already produced, reports `complete: false` with diagnostics,
and writes no verification state — so there is nothing for a later submit to act on.

**Sandboxed validation with a repair pass.** Generated JavaScript is checked in a
permission-restricted child process under a `vm` context and a hard timeout. Failures go
through one stronger-model repair pass. Every solution also carries 2–4 model-derived
worked examples, run locally before anything is typed, so work can be validated even when
the page exposes no tests of its own.

**Content-hash caching and local source retrieval.** Repeated tasks are free. Local
repository checkouts can be indexed ahead of a run and the most relevant excerpts
retrieved per question; the index is stored under `.cache/` with mode `0600`.

## Install

No dependencies and no install step. Requires Node 22+ (developed on Node 25), and the
`agent-browser` CLI on `PATH` for the browser bridge.

## Quick verification

```bash
npm run check
npm test
npm run solve -- fixtures/javascript.json --mock
npm run preflight:browser
```

The browser preflight starts a local 25-card replica and proves the whole path offline:
that capture expands collapsed details, that a default run does not submit, that the
submission gate holds, that the repair pass fires, and that a partially failed lane keeps
its answers and produces no submission token. It never contacts a remote site.

## Browser workflow

You sign in yourself in a dedicated `agent-browser` session; the harness is never given
credentials. Once a page is open, inspect it without touching anything:

```bash
agent-browser --session harness --headed open https://example.com/tasks
npm run bridge -- inspect --session harness --allow-origin https://example.com
```

`inspect` reports page state, visible card count, editor types, prompt lengths, how many
collapsed regions remain hidden, and whether a single submit control was found. It calls
no model and clicks nothing.

```bash
npm run bridge -- run \
  --session harness \
  --allow-origin https://example.com \
  --provider codex \
  --deadline-ms 60000
```

`run` captures prompts, calls the model, fills every editor, runs all visible checks,
re-reads every editor, and stops. It returns a short-lived `verificationToken`. It has
not submitted anything.

To submit that exact verified state:

```bash
npm run bridge -- submit \
  --session harness \
  --verification-state .cache/browser-verification/harness.json \
  --verification-token TOKEN_FROM_RUN
```

Automatic submission requires an explicit confirmation string
(`--submit-after-verify SUBMIT_VERIFIED_RUN`), and even then the click is blocked unless
the run reported `complete: true`, the browser is still on the allowed origin, the
verification is inside its timer window, all editor hashes are unchanged, the element
count is unchanged, and every visible check is passing — re-checked one final time inside
the page before clicking.

## Manifest workflow

Tasks can also come from a local JSON manifest instead of a page, in three kinds:
`javascript` (with visible tests), `source` (multiple-choice questions answered against
indexed local checkouts), and `systems` (a specification plus starter files, returned as
complete file contents). See `fixtures/` for a working example of each.

```bash
npm run index -- tasks.json       # index source roots before any timer starts
npm run solve -- tasks.json
npm run materialize -- out/tasks.submission.json ./output-dir
```

Materialization rejects absolute paths and `..` traversal. Generated C, C++, and Rust are
never compiled or executed.

## CLI

```text
npm run index       -- <manifest.json> [--force]
npm run solve       -- <manifest.json> [--out <file|->] [--deadline-ms <ms>]
                       [--provider <openai|codex|claude|cursor>] [--mock]
npm run materialize -- <submission.json> <output-directory>
npm run bridge      -- inspect|capture|run|submit <options>
npm run review      -- --session <name> [--out <directory>]
```

Every browser operation is queued onto one serialized writer, so no read observes a page
midway through a fill or a check. Logs contain task counts and IDs, never the API key.

Configuration is via `VBH_*` environment variables — models, provider, concurrency, batch
size, reserves, and timeouts. See `.env.example` for the full list.

## Scope and limitations

- The harness only knows what is in the manifest, the local source index, or the visible
  page. It does not probe hidden endpoints or read data the page does not display.
- Visible checks improve reliability but do not prove correctness against hidden ones.
- The Node permission model plus a `vm` context and hard timeout reduce risk when checking
  generated JavaScript. This is not a general-purpose security sandbox — do not point it
  at untrusted code you would not otherwise run.
- Retrieved source excerpts are sent to the configured model. Do not index confidential
  repositories unless that is approved.
- Page interaction is limited to visible controls in a browser session you opened and
  authenticated yourself.

## Origin

This began as a solver harness for [Firecrawl's CheetCode v3
challenge](https://ctf.firecrawl.dev/) — a timed, multi-level programming challenge. That
setting produced the constraints that shaped the design: a hard deadline per level, an
irreversible submit button, and a page whose visible checks were the only available
ground truth. Nothing in it logged in, bypassed access controls, or called private
endpoints.

The challenge-specific parts turned out to be the thin layer. What was left — deadline
budgeting, provider-agnostic structured output, sandboxed validation, and verification
gates around an irreversible click — generalizes to any browser task where being wrong is
expensive.

## License

MIT
