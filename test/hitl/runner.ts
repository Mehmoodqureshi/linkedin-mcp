/**
 * Runner — the single API every scenario uses to execute a step.
 *
 * Responsibilities, centralized here so no scenario can bypass them:
 *   - execute a step's `run()` closure and time it (monotonic clock),
 *   - capture any throw as data (never crash the run),
 *   - screenshot the live page into the results dir,
 *   - print a truncated JSON preview of the output (to stderr — stdout is
 *     reserved for prompts and the final report path),
 *   - for MUTATING steps, apply the three-layer safety gate BEFORE executing,
 *   - collect the human's pass/fail/skip verdict + notes,
 *   - record an immutable StepResult.
 *
 * Scenarios depend on the exact surface below: `runReadOnly`, `runMutating`,
 * and the lower-level `runStep`. None of them throw to the caller — a step
 * failure is recorded, not propagated, so one broken scenario can't abort the
 * run.
 */

import * as path from 'path';

import * as prompts from './prompts';
import type {
  CliOptions,
  MutationPlan,
  RunContext,
  Step,
  StepResult,
} from './types';

/** Max characters of JSON.stringify(result) kept in the report preview. */
const PREVIEW_LIMIT = 2000;

/** Options the Runner is constructed with. */
export interface RunnerOptions {
  /** CLI flags (controls the mutating gate). */
  options: CliOptions;
}

/**
 * A step descriptor as scenarios spell it out, minus the bits the Runner fills
 * in (`kind`, `plan`). Used by the convenience `runReadOnly`/`runMutating`
 * wrappers.
 */
export interface StepDescriptor {
  name: string;
  group?: Step['group'];
  action?: string;
  inputs?: Record<string, unknown>;
  sourceHint?: string;
}

export class Runner {
  private readonly options: CliOptions;
  private readonly results: StepResult[] = [];

  constructor(opts: RunnerOptions) {
    this.options = opts.options;
  }

  // -------------------------------------------------------------------------
  // Public scenario surface
  // -------------------------------------------------------------------------

  /**
   * Execute a read-only step: run, screenshot, preview, verdict, record.
   * Never gates and never throws to the caller.
   */
  async runReadOnly<T>(
    step: StepDescriptor,
    ctx: RunContext,
    exec: () => Promise<T>,
  ): Promise<void> {
    await this.runStep(
      {
        name: step.name,
        kind: 'read',
        ...(step.group !== undefined ? { group: step.group } : {}),
        ...(step.action !== undefined ? { action: step.action } : {}),
        ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
        ...(step.sourceHint !== undefined ? { sourceHint: step.sourceHint } : {}),
        run: exec,
      },
      ctx,
    );
  }

  /**
   * Execute a mutating step behind the three-layer safety gate.
   * Layer 1 (classification) is the call site choosing this method; layers 2
   * (opt-in flag) and 3 (target presence + literal 'yes') are enforced here.
   */
  async runMutating<T>(
    step: StepDescriptor,
    plan: MutationPlan,
    ctx: RunContext,
    exec: () => Promise<T>,
  ): Promise<void> {
    await this.runStep(
      {
        name: step.name,
        kind: 'mutating',
        plan,
        ...(step.group !== undefined ? { group: step.group } : {}),
        ...(step.action !== undefined ? { action: step.action } : {}),
        ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
        ...(step.sourceHint !== undefined ? { sourceHint: step.sourceHint } : {}),
        run: exec,
      },
      ctx,
    );
  }

  /** Immutable snapshot of every recorded step result. */
  getResults(): StepResult[] {
    return [...this.results];
  }

  // -------------------------------------------------------------------------
  // Core execution
  // -------------------------------------------------------------------------

  /**
   * The single execution path for every step. Mutating steps pass through the
   * safety gate first; on any decline the step is recorded as 'skip' and the
   * action is never invoked.
   */
  async runStep(step: Step, ctx: RunContext): Promise<void> {
    const action = step.action ?? step.name;
    this.log(`\n--- ${action} ---`);

    // --- Layer 2 & 3: mutating safety gate (before any execution) ---
    if (step.kind === 'mutating') {
      const gate = await this.gateMutation(step);
      if (!gate.proceed) {
        this.record({
          name: step.name,
          kind: step.kind,
          ...(step.group !== undefined ? { group: step.group } : {}),
          action,
          ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
          status: 'skip',
          durationMs: 0,
          outputPreview: '',
          notes: gate.note,
          ...(step.sourceHint !== undefined ? { sourceHint: step.sourceHint } : {}),
        });
        this.log(prompts.colors.skip(`  skipped: ${gate.note}`));
        return;
      }
    }

    // --- Execute & time (monotonic) ---
    const start = process.hrtime.bigint();
    let output: unknown;
    let error: string | undefined;
    let threw = false;

    try {
      output = await step.run(ctx);
    } catch (err) {
      threw = true;
      error = formatError(err);
    }

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    // --- Preview ---
    const { preview, truncated } = previewOf(output);
    if (threw) {
      this.log(prompts.colors.fail(`  ERROR: ${error}`));
    } else {
      this.log(`  output: ${preview}`);
    }
    this.log(`  duration: ${durationMs.toFixed(0)}ms`);

    // --- Screenshot (best-effort; failure never aborts the step) ---
    const screenshot = await this.captureScreenshot(ctx, step.name);
    if (screenshot) this.log(`  screenshot: ${screenshot}`);

    // --- Verdict ---
    // A throw is an automatic FAIL, but we still collect the human's notes so
    // the report carries context for the tuning pass.
    let status: StepResult['status'];
    let notes: string;

    if (threw) {
      this.log(prompts.colors.fail('  (auto-FAIL: action threw)'));
      notes = await prompts.ask('notes (optional, Enter to skip): ');
      status = 'fail';
    } else {
      const v = await prompts.verdict();
      status = v.result;
      notes = v.notes;
    }

    this.record({
      name: step.name,
      kind: step.kind,
      ...(step.group !== undefined ? { group: step.group } : {}),
      action,
      ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
      status,
      durationMs,
      outputPreview: preview,
      outputTruncated: truncated,
      ...(error !== undefined ? { error } : {}),
      threw,
      ...(screenshot !== undefined ? { screenshot } : {}),
      notes,
      ...(step.sourceHint !== undefined ? { sourceHint: step.sourceHint } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Safety gate
  // -------------------------------------------------------------------------

  /**
   * Layers 2 & 3 of the safety model. Returns whether to proceed and, when not,
   * the note explaining why the step was skipped.
   */
  private async gateMutation(
    step: Step,
  ): Promise<{ proceed: true } | { proceed: false; note: string }> {
    // Layer 2 — opt-in flag.
    if (!this.options.includeMutating) {
      return {
        proceed: false,
        note: 'mutating step skipped (no --include-mutating)',
      };
    }

    const plan = step.plan;

    // Layer 3a — a real, human-supplied target must exist.
    if (!plan || !plan.target || plan.target.trim() === '') {
      return { proceed: false, note: 'no safe target configured' };
    }

    // Layer 3b — bright, bounded confirm block + literal 'yes'.
    const action = step.action ?? step.name;
    this.log('');
    this.log(
      prompts.colors.fail(
        prompts.colors.bold('=== MUTATING ACTION — WILL MODIFY LINKEDIN ==='),
      ),
    );
    this.log(`action: ${action}`);
    this.log(`target: ${plan.target}`);
    if (plan.payload && Object.keys(plan.payload).length > 0) {
      this.log(`payload: ${JSON.stringify(plan.payload)}`);
    }
    this.log(`effect: ${plan.effect}`);

    const ok = await prompts.confirmYes('Confirm this mutation');
    if (!ok) {
      return { proceed: false, note: 'declined at confirm-gate' };
    }
    return { proceed: true };
  }

  // -------------------------------------------------------------------------
  // Screenshot
  // -------------------------------------------------------------------------

  /**
   * Capture a full-page screenshot into the results dir, returning the path
   * relative to that dir. Any failure is swallowed (recorded as no screenshot)
   * so a flaky capture never aborts a step.
   */
  private async captureScreenshot(
    ctx: RunContext,
    stepId: string,
  ): Promise<string | undefined> {
    const file = `${stepId}.png`;
    const abs = path.join(ctx.resultsDir, file);
    try {
      const page = await ctx.driver.browser.getPage();
      await page.screenshot({ fullPage: true, path: abs });
      return file;
    } catch (err) {
      this.log(
        prompts.colors.skip(`  (screenshot failed: ${formatError(err)})`),
      );
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private record(result: StepResult): void {
    this.results.push(result);
  }

  /** Diagnostic output goes to stderr (stdout is for prompts / report path). */
  private log(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON.stringify a value, truncating to PREVIEW_LIMIT chars with a flag. */
function previewOf(value: unknown): { preview: string; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  if (json.length > PREVIEW_LIMIT) {
    return { preview: `${json.slice(0, PREVIEW_LIMIT)}…`, truncated: true };
  }
  return { preview: json, truncated: false };
}

/** Error message plus its first stack line, as the tuning signal. */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    const firstStack = err.stack?.split('\n')[1]?.trim();
    return firstStack ? `${err.message} | ${firstStack}` : err.message;
  }
  return String(err);
}
