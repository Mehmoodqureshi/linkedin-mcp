/**
 * search.scenario.ts — HITL suite for the search vertical.
 *
 * Covers the three READ-ONLY search actions exposed by the driver:
 *   - search.searchPeople(targets.peopleQuery)
 *   - search.searchJobs(targets.jobsQuery)
 *   - search.searchCompanies(targets.companiesQuery)
 *
 * Every step is read-only, so the suite never touches `runner.runMutating` and
 * imports no mutating driver method — Layer 1 of the safety model is satisfied
 * structurally. Each step calls the real driver action and RETURNS the raw
 * result; the Runner owns timing, screenshots, the truncated preview and the
 * pass/fail/skip verdict. To help the human eyeball correctness, we also print
 * the result count and the first three entries to stderr before handing control
 * back to the Runner's verdict prompt.
 *
 * Targets are validated lazily: if a query key is blank we record a graceful
 * skip (via a no-op exec that returns a sentinel and a clear note prompt) rather
 * than firing a useless empty search or crashing the suite.
 */

import * as prompts from '../prompts';
import type { RunContext, ScenarioCtx, ScenarioModule } from '../types';

const SOURCE_HINT = 'src/driver/actions/search.ts';
const GROUP = 'search' as const;

/**
 * The Runner's `runReadOnly` needs a full RunContext (live page, results dir,
 * artifact sink), while a scenario's `run()` receives a ScenarioCtx. The
 * orchestrator (index.ts) builds the ScenarioCtx as a superset that also carries
 * the RunContext fields, so we narrow to RunContext here in one guarded place.
 */
function asRunContext(ctx: ScenarioCtx): RunContext {
  return ctx as unknown as RunContext;
}

/** Pretty-print the first `n` items of a result list to stderr for the human. */
function previewList(label: string, items: readonly unknown[], n = 3): void {
  process.stderr.write(`  ${label}: ${items.length} result(s)\n`);
  const head = items.slice(0, n);
  head.forEach((item, i) => {
    process.stderr.write(`    [${i}] ${JSON.stringify(item)}\n`);
  });
  if (items.length > n) {
    process.stderr.write(`    … ${items.length - n} more\n`);
  }
}

/**
 * Run a read-only search step, or record a graceful skip when its query target
 * is missing. The exec closure both performs the action and prints the
 * count + first-three preview so the human can judge the result.
 */
async function searchStep(
  ctx: ScenarioCtx,
  opts: {
    name: string;
    action: string;
    query: string;
    queryKey: string;
    label: string;
    exec: (query: string) => Promise<readonly unknown[]>;
  },
): Promise<void> {
  const rctx = asRunContext(ctx);
  const descriptor = {
    name: opts.name,
    group: GROUP,
    action: opts.action,
    inputs: { query: opts.query },
    sourceHint: SOURCE_HINT,
  };

  if (!opts.query || opts.query.trim() === '') {
    // No target configured: do not fire an empty search. Record a skip-shaped
    // result by returning a sentinel and letting the human mark it skip.
    process.stderr.write(
      prompts.colors.skip(
        `  (no "${opts.queryKey}" configured in test-targets.json — skipping ${opts.action})\n`,
      ),
    );
    await ctx.runner.runReadOnly(descriptor, rctx, async () => ({
      skipped: true,
      reason: `no "${opts.queryKey}" target configured`,
    }));
    return;
  }

  await ctx.runner.runReadOnly(descriptor, rctx, async () => {
    const results = await opts.exec(opts.query);
    previewList(opts.label, results);
    return results;
  });
}

const scenario: ScenarioModule = {
  id: 'search',
  label: 'Search (people / jobs / companies) — read-only',
  group: GROUP,

  async run(ctx: ScenarioCtx): Promise<void> {
    const { driver, targets } = ctx;

    // people
    await searchStep(ctx, {
      name: 'search-searchPeople',
      action: 'search.searchPeople',
      query: targets.peopleQuery,
      queryKey: 'peopleQuery',
      label: 'people',
      exec: (q) => driver.search.searchPeople(q),
    });

    // jobs
    await searchStep(ctx, {
      name: 'search-searchJobs',
      action: 'search.searchJobs',
      query: targets.jobsQuery,
      queryKey: 'jobsQuery',
      label: 'jobs',
      exec: (q) => driver.search.searchJobs(q),
    });

    // companies
    await searchStep(ctx, {
      name: 'search-searchCompanies',
      action: 'search.searchCompanies',
      query: targets.companiesQuery,
      queryKey: 'companiesQuery',
      label: 'companies',
      exec: (q) => driver.search.searchCompanies(q),
    });
  },
};

export default scenario;
