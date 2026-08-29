# Operating contract

Rules for any agent or person operating this harness. They exist because the harness
drives a real browser against a real page, and one of its actions is irreversible.

## Safety boundary

- **Never submit without authorization.** Final submission is a separately authorized
  action. The default `run` never clicks it. Automatic submission requires the exact
  `SUBMIT_VERIFIED_RUN` confirmation string, and even then every verification gate must
  pass.
- **Never automate sign-in, MFA, or credential entry.** The operator authenticates
  manually in a headed `agent-browser` session. The harness is never given credentials.
- **Use visible controls and visible content only.** Do not call private endpoints,
  inspect hidden application state, or read data the page does not display.
- **Stay on the allowed origin.** Every browser command takes `--allow-origin`. A
  verification is void the moment the browser leaves that origin.
- **Treat a target site's terms as binding.** This tool can drive any page; that is not
  permission to drive every page. Confirm the operator is authorized to automate the
  target before running against it.

## Working model

- **The page is the oracle.** A model's confidence in its own answer is not evidence.
  Only a visible check that reports passing counts, and it is re-read from the page
  after the fill, never inferred from what was typed.
- **Serialize browser writes.** All operations queue onto one writer. Model workers
  produce structured answers; they never touch the browser session directly.
- **Partial results are kept, not discarded.** A run that loses work to the deadline
  fills and checks what it has, reports `complete: false` with diagnostics, and writes
  no verification state — so nothing downstream can act on an incomplete run.
- **Deadlines are hard.** Expensive work stops starting as the deadline approaches, and
  an output reserve is held back so results can always be written.

## Cost and provider discipline

- Do not silently switch between a subscription-backed CLI provider and metered API
  billing. The provider is an explicit choice (`--provider`, `VBH_MODEL_PROVIDER`).
- Do not run paid benchmarks or latency measurements unless the operator asks for them.
- `npm run preflight:subscription` consumes real allowance. `npm run preflight:browser`
  and `--mock` do not, and are the correct default for verifying changes.

## Before changing anything

Read `docs/ORCHESTRATION.md` for the control plane and its state machine, then
`src/browser/runner.mjs` and `src/browser/page-adapter.mjs`.

Verify with:

```bash
npm run check
npm test
npm run preflight:browser
```

All three must pass. The browser preflight runs entirely against a local replica and
contacts nothing remote — it is the check that proves the submission gate still holds.
