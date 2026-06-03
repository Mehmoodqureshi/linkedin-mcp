/**
 * index.ts — entry point / orchestrator for the HITL (human-in-the-loop) test
 * harness.
 *
 * Flow (see the design doc):
 *   1. parseArgs()  -> CliOptions (--only / --include-mutating / --headed|--headless)
 *   2. loadTargets() reads + validates test-targets.json (gitignored). Missing
 *      file -> friendly pointer to test-targets.example.json + exit(1).
 *   3. Create test-results/<timestamp>/ run dir (colons in the ISO timestamp
 *      replaced with dashes so it is a valid path segment on every OS).
 *   4. Force headed mode by setting LINKEDIN_HEADLESS BEFORE getInstance() — the
 *      driver reads this env in its constructor — then launch().
 *   5. Assert we are logged in; if not, prompt the human to log in in the visible
 *      window and press Enter, then re-check via auth.isLoggedIn().
 *   6. Run the selected scenario suites through the Runner. Read-only steps run
 *      with no confirmation; mutating steps are gated by the Runner (opt-in flag
 *      -> target presence -> literal 'yes'), so a default run is 100% read-only.
 *   7. writeReport() emits report.json + report.md; printSummary() prints a tally.
 *   8. SIGINT handler + try/finally guarantee driver.close() + readline teardown
 *      and a (partial) report are always written.
 *
 * stdout is reserved for the interactive prompts and the final report path
 * (MCP-stdout discipline); all diagnostics go to stderr.
 */

import * as fs from 'fs';
import * as path from 'path';

import { parseArgs, printHelp } from './cli';
import * as prompts from './prompts';
import { writeReport, printSummary } from './reporter';
import { Runner } from './runner';
import { loadTargets, requireTarget } from './targets';
import type { Targets } from './targets';
import type {
  CliOptions,
  RunContext,
  ScenarioCtx,
  ScenarioGroup,
  ScenarioModule,
  Step,
  TestTargets,
} from './types';

// ---------------------------------------------------------------------------
// Suite registry
// ---------------------------------------------------------------------------

/**
 * The scenario suites that exist under ./scenarios. Order here is the run order.
 *
 * Two shapes coexist in the scenario files (both are supported):
 *   - "run-style": default export is a `ScenarioModule` with `run(ctx)`. The
 *     suite sequences its own runner.runReadOnly / runner.runMutating calls.
 *     (auth, profile, search, feed, messages)
 *   - "steps-style": default export is `{ name, steps: Step[] }` and a
 *     `build<Suite>Scenario(targets)` factory binds human-supplied targets into
 *     the steps' plans; we run each step via runner.runStep. (connections)
 */
const SUITE_ORDER: ScenarioGroup[] = [
  'auth',
  'profile',
  'search',
  'feed',
  'messages',
  'connections',
];

/** A loaded suite, normalized to a single `run(ctx)` we can call uniformly. */
interface LoadedSuite {
  group: ScenarioGroup;
  run(ctx: ScenarioCtx): Promise<void>;
}

/**
 * Dynamically import a suite module and normalize it to a `run(ctx)`.
 *
 * - Run-style modules already have `run`; we use it directly.
 * - The steps-style `connections` module exposes `buildConnectionsScenario` to
 *   bind targets into each step's plan; we build it, then drive every step
 *   through `ctx.runner.runStep`.
 */
async function loadSuite(group: ScenarioGroup): Promise<LoadedSuite> {
  const mod = (await import(`./scenarios/${group}.scenario`)) as {
    default?: unknown;
    buildConnectionsScenario?: (t: {
      connectionTarget?: { profileUrl: string; note?: string };
      acceptRequestProfileId?: string;
      withdrawTarget?: { profileId?: string; profileUrl?: string };
    }) => { name: string; steps: Step[] };
  };

  const def = mod.default;

  // Run-style: default export carries a run(ctx) method.
  if (def && typeof (def as ScenarioModule).run === 'function') {
    const sm = def as ScenarioModule;
    return { group, run: (ctx) => sm.run(ctx) };
  }

  // Steps-style: connections exposes a factory + a { name, steps } default.
  if (typeof mod.buildConnectionsScenario === 'function') {
    const build = mod.buildConnectionsScenario;
    return {
      group,
      async run(ctx: ScenarioCtx): Promise<void> {
        const built = build({
          ...(ctx.targets.connectionTarget !== undefined
            ? { connectionTarget: ctx.targets.connectionTarget }
            : {}),
          ...(ctx.targets.acceptRequestProfileId !== undefined
            ? { acceptRequestProfileId: ctx.targets.acceptRequestProfileId }
            : {}),
          ...(ctx.targets.withdrawTarget !== undefined
            ? { withdrawTarget: ctx.targets.withdrawTarget }
            : {}),
        });
        for (const step of built.steps) {
          // The Runner owns gating/screenshots/verdict; runStep never throws.
          await ctx.runner.runStep(step, ctx.rc);
        }
      },
    };
  }

  // Last-resort: a bare { steps } default with no factory.
  if (def && Array.isArray((def as { steps?: unknown }).steps)) {
    const steps = (def as { steps: Step[] }).steps;
    return {
      group,
      async run(ctx: ScenarioCtx): Promise<void> {
        for (const step of steps) await ctx.runner.runStep(step, ctx.rc);
      },
    };
  }

  throw new Error(
    `[hitl] scenario module ./scenarios/${group}.scenario has no runnable export ` +
      `(expected a default { run } or a buildScenario factory).`,
  );
}

/** Apply the --only filter (null/empty means "all"), preserving run order. */
function selectSuites(only: string[] | null): ScenarioGroup[] {
  if (!only || only.length === 0) return [...SUITE_ORDER];
  const wanted = new Set(only.map((s) => s.toLowerCase()));
  const known = new Set<string>(SUITE_ORDER);
  for (const g of wanted) {
    if (!known.has(g)) {
      process.stderr.write(
        `[hitl] warning: unknown suite "${g}" in --only (ignored). ` +
          `Known: ${SUITE_ORDER.join(', ')}.\n`,
      );
    }
  }
  return SUITE_ORDER.filter((g) => wanted.has(g));
}

// ---------------------------------------------------------------------------
// Targets bridging
// ---------------------------------------------------------------------------

/**
 * targets.ts validates a slightly looser `Targets` (optional messageTarget /
 * connectionTarget); the scenario contract expects `TestTargets` where those
 * are required. They are structurally compatible at the fields the scenarios
 * actually read (each scenario guards its own optional keys), so we bridge with
 * a single narrowing here, supplying empty defaults for the two keys the
 * scenario type marks required.
 */
function toTestTargets(t: Targets): TestTargets {
  return {
    ...t,
    messageTarget: t.messageTarget ?? { profileUrl: '', body: '' },
    connectionTarget: t.connectionTarget ?? { profileUrl: '' },
  } as TestTargets;
}

// ---------------------------------------------------------------------------
// Run directory
// ---------------------------------------------------------------------------

/** Build (and create) test-results/<timestamp>/ at the project root. */
function makeRunDir(): string {
  const root = path.resolve(__dirname, '..', '..');
  // Colons are illegal in Windows path segments and awkward everywhere; replace.
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const dir = path.join(root, 'test-results', stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

/**
 * Ensure we are authenticated before running any suite. If the restored session
 * is already logged in we proceed silently. Otherwise we pause: the human logs
 * in (and clears 2FA/captcha) in the visible window, presses Enter, and we
 * re-check via the live `auth.isLoggedIn()`. We retry a small number of times
 * before giving up.
 */
async function ensureLoggedIn(
  driver: import('../../src/driver/linkedin').LinkedInDriver,
): Promise<boolean> {
  const status = driver.getStatus();
  if (status.isLoggedIn) {
    process.stderr.write('[hitl] session restored — already logged in.\n');
    return true;
  }

  process.stderr.write(
    '[hitl] not logged in. A visible browser window is open.\n',
  );

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await prompts.ask(
      `Log in to LinkedIn in the open window (finish any 2FA), then press Enter ` +
        `(attempt ${attempt}/${MAX_ATTEMPTS}): `,
    );
    let loggedIn = false;
    try {
      loggedIn = await driver.auth.isLoggedIn();
    } catch (err) {
      process.stderr.write(
        `[hitl] login check failed: ${(err as Error).message}\n`,
      );
    }
    if (loggedIn) {
      // Keep driver.getStatus() accurate for the report + mutating preconditions.
      try {
        await driver.refreshSession();
      } catch {
        /* non-fatal */
      }
      process.stderr.write('[hitl] login confirmed.\n');
      return true;
    }
    process.stderr.write('[hitl] still not logged in.\n');
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options: CliOptions = normalizeCli(parseArgs(process.argv.slice(2)));

  // --help short-circuits before any side effects.
  const rawHelp = process.argv.slice(2).includes('--help') ||
    process.argv.slice(2).includes('-h');
  if (rawHelp) {
    printHelp();
    return;
  }

  // 2. Load + validate targets (exits with a friendly pointer if missing).
  const rawTargets = loadTargets();
  const targets = toTestTargets(rawTargets);

  // 1 (selection). Determine which suites to run.
  const suites = selectSuites(parseArgs(process.argv.slice(2)).only);
  if (suites.length === 0) {
    process.stderr.write(
      '[hitl] no suites selected (check --only). Nothing to run.\n',
    );
    return;
  }
  // Fail fast on read-only target requirements for the selected suites, so a
  // misconfigured run errors before we boot a browser. (Mutating targets are
  // enforced lazily inside the Runner's gate, per the safety model.)
  validateReadOnlyTargets(rawTargets, suites);

  // 3. Run directory.
  const runDir = makeRunDir();
  // Published for any scenario that reads it directly (e.g. profile.scenario.ts).
  process.env.HITL_RESULTS_DIR = runDir;
  process.stderr.write(`[hitl] results dir: ${runDir}\n`);

  // 4. Force headed mode BEFORE getInstance() — the driver reads env in its ctor.
  process.env.LINKEDIN_HEADLESS = options.headed ? '0' : '1';
  if (!options.headed) {
    process.stderr.write(
      '[hitl] WARNING: --headless set; mutations would not be visually observable.\n',
    );
  }

  // Import the facade only AFTER the env is set.
  const { getInstance } = await import('../../src/driver/linkedin');
  const driver = getInstance();

  const runner = new Runner({ options });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // 8. Cleanup is centralized: closed exactly once, by finally OR SIGINT.
  let closed = false;
  const writeAndClose = async (reason: string): Promise<void> => {
    if (closed) return;
    closed = true;
    process.stderr.write(`\n[hitl] shutting down (${reason})…\n`);
    const results = runner.getResults();
    try {
      writeReport(runDir, results, {
        startedAt,
        durationMs: Date.now() - startMs,
        suites,
      });
      printSummary(results);
    } catch (err) {
      process.stderr.write(
        `[hitl] failed to write report: ${(err as Error).message}\n`,
      );
    }
    try {
      await driver.close();
    } catch (err) {
      process.stderr.write(
        `[hitl] driver.close() failed: ${(err as Error).message}\n`,
      );
    }
    prompts.closeReadline();
  };

  // SIGINT (Ctrl-C): still flush a partial report, then exit non-zero.
  let sigint = false;
  process.on('SIGINT', () => {
    if (sigint) process.exit(130); // second Ctrl-C: force.
    sigint = true;
    void writeAndClose('SIGINT').then(() => process.exit(130));
  });

  try {
    process.stderr.write('[hitl] launching browser…\n');
    await driver.launch();

    const st = driver.getStatus();
    process.stderr.write(
      `[hitl] driver status: ${st.status} (sessionValid=${st.sessionValid})\n`,
    );

    // 5. Login gate.
    const ok = await ensureLoggedIn(driver);
    if (!ok) {
      process.stderr.write(
        '[hitl] could not confirm a logged-in session — aborting before any suite runs.\n',
      );
      return;
    }

    // Build the single context object that satisfies BOTH ScenarioCtx and
    // RunContext (a superset). `rc` points back at the same object so scenarios
    // that destructure `ctx.rc` (or cast ctx -> RunContext) get a live context
    // with page + resultsDir + recordArtifact, and never assemble it themselves.
    const page = await driver.getPage();
    const base = {
      driver,
      page,
      targets,
      options,
      resultsDir: runDir,
      runner,
      async recordArtifact(name: string, data: unknown): Promise<string> {
        const abs = path.join(runDir, name);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
        return abs;
      },
    };
    // The context satisfies BOTH ScenarioCtx and RunContext (a superset). `rc`
    // self-references so scenarios that destructure `ctx.rc` — or cast
    // ctx -> RunContext — get a live context (page + resultsDir +
    // recordArtifact) and never assemble it themselves.
    const ctx: ScenarioCtx & RunContext = { ...base, rc: base as RunContext };

    // 6. Run each selected suite. A throw inside a suite is logged but never
    // aborts the rest of the run (per-step failures are already data, not crashes).
    for (const group of suites) {
      process.stderr.write(`\n[hitl] ===== suite: ${group} =====\n`);
      try {
        const suite = await loadSuite(group);
        await suite.run(ctx);
      } catch (err) {
        process.stderr.write(
          `[hitl] suite "${group}" crashed: ${(err as Error).message}\n`,
        );
      }
    }
  } finally {
    // 7 + 8. Always write the report and tear down (guards against the SIGINT
    // path having already run).
    await writeAndClose('done');
  }
}

/**
 * Enforce read-only target presence for the selected suites up front, so a
 * misconfigured run fails fast (before launching a browser) with a clear
 * pointer. Mutating-only keys are intentionally NOT required here — they are
 * gated lazily inside the Runner so a read-only default run never demands them.
 */
function validateReadOnlyTargets(
  targets: Targets,
  suites: ScenarioGroup[],
): void {
  try {
    if (suites.includes('profile')) {
      requireTarget(targets, 'profileUrls', 'profile');
    }
    if (suites.includes('search')) {
      // searchPeople is the canonical read for the suite; the scenario skips the
      // rest gracefully if their queries are blank.
      requireTarget(targets, 'peopleQuery', 'search');
    }
    // auth / feed / messages / connections all degrade gracefully with empty
    // optional targets (they record skips), so they need no up-front check.
  } catch (err) {
    process.stderr.write(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * The cli.ts CliOptions uses `only: string[] | null`; the harness types.ts
 * CliOptions uses `only: ScenarioGroup[]` + always-present flags. Narrow into
 * the types.ts shape the Runner + scenarios consume.
 */
function normalizeCli(parsed: {
  only: string[] | null;
  includeMutating: boolean;
  headed: boolean;
  help: boolean;
}): CliOptions {
  const known = new Set<string>(SUITE_ORDER);
  const only = (parsed.only ?? []).filter((g): g is ScenarioGroup =>
    known.has(g),
  );
  return {
    only,
    includeMutating: parsed.includeMutating,
    headed: parsed.headed,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

main().catch((err) => {
  process.stderr.write(`\n[hitl] fatal: ${(err as Error).stack ?? err}\n`);
  // Best-effort readline teardown so the process can exit cleanly.
  try {
    prompts.closeReadline();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
