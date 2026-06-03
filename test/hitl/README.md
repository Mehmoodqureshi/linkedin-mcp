# HITL test harness

A **human-in-the-loop** harness that drives the **live** LinkedIn site in a
**headed** browser, pauses after every action for a human pass / fail / skip
verdict, and emits a tuning report that maps each failure to the source file
whose selectors/actions most likely broke.

It runs as a standalone `ts-node` process against the real driver facade
(`src/driver/linkedin.ts`) using only its public surface — it is **not** an
automated test suite and never runs in CI. You sit in front of it.

---

## 1. Set up `test-targets.json`

The harness reads **one** file for every account / URL / query it is allowed to
touch: `test-targets.json` at the **project root**. It is gitignored — never
commit real targets.

```bash
cp test/hitl/test-targets.example.json test-targets.json
# then edit test-targets.json
```

Fill in the keys for the suites you plan to run. Read-only keys feed the read
suites; the **mutation keys** (`messageTarget`, `connectionTarget`,
`acceptRequestProfileId`, `withdrawTarget`, `likePostUrl`, `reactTarget`,
`commentTarget`, `allowLogout`) are the
**only** values a mutating action is ever allowed to touch — use safe test
accounts / posts **you control**. Every key is documented inline in the
`_README` block of `test-targets.example.json`.

You also need a logged-in session. Browser/login config comes from the same env
the driver uses (`LINKEDIN_USER_DATA_DIR`, optionally `LINKEDIN_EMAIL`); the
harness **forces headed mode** so you can finish 2FA/captcha by hand. If the
restored session isn't logged in, the harness pauses and asks you to log in in
the visible window and press Enter.

---

## 2. Run it

```bash
# Read-only (default): a default run is 100% read-only even if you select a
# suite that contains mutating steps — they are auto-skipped.
npm run test:hitl

# Only specific suites:
npm run test:hitl -- --only profile,search

# Opt in to MUTATING actions (still gated per-step, see Safety):
npm run test:hitl -- --only connections --include-mutating
# or the convenience alias that adds --include-mutating for you:
npm run test:hitl:all -- --only connections

npm run test:hitl -- --help
```

Suites: `auth`, `profile`, `search`, `feed`, `messages`, `connections`.

For each step the harness runs the action, screenshots the page, prints a
truncated JSON preview (to **stderr**), then asks you for a verdict
(`[p]ass` / `[f]ail` / `[s]kip`) and optional notes. Prompts and the final
report path go to **stdout**; everything else is stderr (MCP-stdout discipline).

### Safety — three layers (mutating actions)

A mutating LinkedIn action can never fire without explicit per-step consent on a
human-supplied target:

1. **Classification** — read steps call `runner.runReadOnly`; mutating steps call
   `runner.runMutating`. Read suites import no mutating driver method.
2. **Opt-in flag** — without `--include-mutating`, every mutating step is
   auto-recorded as `skip` and the action is never called.
3. **Per-step confirm + target whitelist** — with `--include-mutating`, the
   runner prints a bounded `=== MUTATING ACTION ===` block (action / target /
   payload / effect) and requires you to type the literal word **`yes`** (`y`
   does not count). The `target` comes **only** from a dedicated config key, so a
   mutation can only ever touch a pre-approved account. An empty target records
   `skip` ("no safe target configured").

Headed mode is forced and the runner re-checks `driver.getStatus()` is `ready`
and logged-in before any mutating step.

---

## 3. Read the report

Each run writes to `test-results/<timestamp>/` (gitignored):

- **`report.md`** — human-readable tuning report: run metadata, a
  pass/fail/skip summary, a per-step Results table, a **FAILURES & TUNING HINTS**
  section grouped by the `src/driver/actions/*.ts` file to edit, and a Skipped
  section so gated/unconfigured steps aren't mistaken for passes.
- **`report.json`** — the same data, machine-readable (`run` metadata + the full
  `steps[]` array). Both artifacts are built from the same records so they can't
  drift.
- **`<stepId>.png`** — a full-page screenshot per step.

A failure that **threw** is hinted `(threw — check navigation/auth guard +
selector existence)`; one that **returned** but you marked wrong is hinted
`(returned — selectors matched stale/incorrect nodes, verify normalized shape)`.

---

## 4. The tuning loop

```
run a suite  ->  read report.md failures (grouped by source file)
             ->  open exactly those src/driver/actions/*.ts files
             ->  fix the drifted selectors / navigation
             ->  re-run the same suite  ->  repeat until green
```

Because failures are grouped by source file, one tuning pass = one file open.
Start at the top of the **FAILURES & TUNING HINTS** section and work down.

---

## How it's wired (for maintainers)

- **`index.ts`** — orchestrator: parse args → load+validate targets → make the
  run dir → force `LINKEDIN_HEADLESS` **before** `getInstance()` → `launch()` →
  login gate → run selected suites through the `Runner` → `writeReport` +
  `printSummary` → `close()`. A `SIGINT` handler and a `try/finally` guarantee
  the browser + readline close and a (partial) report is always written.
- **`runner.ts`** — the single API scenarios call (`runReadOnly`, `runMutating`,
  `runStep`); owns timing, screenshots, the mutation gate, the verdict prompt and
  the `StepResult` record. A step failure is data, never a crash.
- **`cli.ts` / `targets.ts` / `prompts.ts` / `reporter.ts`** — arg parsing,
  config load+validate, readline prompts, report emission.
- **`scenarios/*.scenario.ts`** — thin, declarative suites. Most export a
  `{ run(ctx) }` module; `connections` exports a `buildConnectionsScenario(targets)`
  factory that binds the human-supplied target into the mutating step's plan.
  `index.ts` normalizes both shapes to a single `run(ctx)`.

### Build / tsconfig note

The production build (`npm run build`, `tsc -p tsconfig.json`) intentionally does
**not** compile `test/` — the root tsconfig's `include` is `src/**` + `scripts/**`
only, so nothing under `test/` lands in `dist/`. `ts-node` compiles
`test/hitl/index.ts` and its imports **on the fly** (the root tsconfig's
`ts-node.transpileOnly` block), so no separate `tsconfig.test.json` is needed and
`npm run build` stays clean. The `test:hitl` scripts therefore point at the root
`tsconfig.json`.
