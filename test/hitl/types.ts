/**
 * Shared types for the HITL (human-in-the-loop) test harness.
 *
 * These types are the contract between the Runner, the prompt helpers, the
 * scenario files and the report writer. Everything that crosses a module
 * boundary inside `test/hitl/` is declared here so the pieces compile against a
 * single, stable surface.
 */

import type { Page } from 'playwright';
import type { LinkedInDriver } from '../../src/driver/linkedin';
import type { ReactionType } from '../../src/driver/actions/feed';

// ---------------------------------------------------------------------------
// Verdicts & step classification
// ---------------------------------------------------------------------------

/** A human's judgement of a step's outcome. */
export type Verdict = 'pass' | 'fail' | 'skip';

/** Whether a step only reads from LinkedIn or mutates remote state. */
export type StepKind = 'read' | 'mutating';

/** Logical grouping for `--only` filtering and report sectioning. */
export type ScenarioGroup =
  | 'auth'
  | 'profile'
  | 'search'
  | 'messages'
  | 'connections'
  | 'feed';

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

/** Parsed command-line options (see cli.ts). */
export interface CliOptions {
  /** Scenario groups to run; empty means "all". */
  only: ScenarioGroup[];
  /** When false, every mutating step is auto-skipped before execution. */
  includeMutating: boolean;
  /** Headed mode flag (always true for HITL unless explicitly overridden). */
  headed: boolean;
}

/** MUTATING sendMessage target — a safe test account the human controls. */
export interface MessageTarget {
  profileUrl: string;
  body: string;
}

/** MUTATING sendConnectionRequest target + optional note (<=300 chars). */
export interface ConnectionTarget {
  profileUrl: string;
  note?: string;
}

/** MUTATING withdrawConnectionRequest target (one of the two ids). */
export interface WithdrawTarget {
  profileId?: string;
  profileUrl?: string;
}

/** MUTATING feed.reactToPost target — a safe post permalink + reaction. */
export interface ReactTarget {
  postUrl: string;
  /** Which reaction to apply; defaults to 'like' when omitted. */
  reaction?: ReactionType;
}

/** MUTATING feed.commentOnPost target — a safe post permalink + body. */
export interface CommentTarget {
  postUrl: string;
  text: string;
}

/**
 * The validated contents of `test/hitl/test-targets.json`. Read-only keys feed
 * read scenarios; the mutation-target keys are the ONLY values a mutating step
 * is permitted to touch (see the safety model).
 */
export interface TestTargets {
  profileUrls: string[];
  profileUsernames: string[];
  peopleQuery: string;
  jobsQuery: string;
  companiesQuery: string;
  conversationId?: string;
  messageTarget: MessageTarget;
  connectionTarget: ConnectionTarget;
  acceptRequestProfileId?: string;
  withdrawTarget?: WithdrawTarget;
  likePostUrl: string;
  reactTarget?: ReactTarget;
  commentTarget?: CommentTarget;
  allowLogout?: boolean;
}

// ---------------------------------------------------------------------------
// Step execution context
// ---------------------------------------------------------------------------

/**
 * Everything a step's `run()` closure (and the Runner) needs to do its work.
 * Scenarios receive this so they never reach for readline, fs or the raw Page
 * outside of the helpers the Runner provides.
 */
export interface RunContext {
  /** The live, launched driver — steps call the real action methods on it. */
  driver: LinkedInDriver;
  /** The live primary page, for screenshots / artifacts. */
  page: Page;
  /** Validated config targets the steps draw their inputs from. */
  targets: TestTargets;
  /** CLI options (e.g. to consult includeMutating). */
  options: CliOptions;
  /** Absolute path to this run's results directory. */
  resultsDir: string;
  /**
   * Persist an arbitrary artifact (e.g. a JSON dump) into the results dir.
   * Returns the absolute path written.
   */
  recordArtifact(name: string, data: unknown): Promise<string>;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A single declarative unit of work. `run()` performs the action and returns
 * its raw result; the Runner owns timing, screenshots, mutation gating and the
 * verdict prompt. For mutating steps, `plan` describes exactly what will change
 * so the confirm-gate can show it to the human before anything fires.
 */
export interface Step {
  /** Stable id, e.g. `profile-getProfile-1`. Used for the screenshot filename. */
  name: string;
  /** Read-only or mutating — drives the safety gate. */
  kind: StepKind;
  /** Logical group, echoed into the report. */
  group?: ScenarioGroup;
  /** Action label, e.g. `profile.getProfile`. Defaults to `name`. */
  action?: string;
  /** Inputs echoed verbatim into the report (exactly what was passed). */
  inputs?: Record<string, unknown>;
  /** Source file whose selectors/actions to tune if this step fails. */
  sourceHint?: string;
  /**
   * For mutating steps: the human-facing description shown in the confirm-gate.
   * Required when `kind === 'mutating'`; ignored otherwise.
   */
  plan?: MutationPlan;
  /** Performs the action and returns its raw result. */
  run(ctx: RunContext): Promise<unknown>;
}

/**
 * Human-readable description of a mutation, shown verbatim in the confirm-gate.
 * The `target` MUST originate from a dedicated config key (never a synthesized
 * or search-derived value), so a mutation only ever touches a pre-approved
 * account.
 */
export interface MutationPlan {
  /** One-line description of the side effect. */
  effect: string;
  /** The exact, human-supplied target (profile URL / id / post URL). */
  target: string;
  /** The payload (note text, message body, etc.). */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The recorded outcome of executing one step. */
export interface StepResult {
  /** The step's stable id. */
  name: string;
  /** Logical group, when known. */
  group?: ScenarioGroup;
  /** Action label. */
  action?: string;
  /** Read-only or mutating. */
  kind: StepKind;
  /** Inputs echoed from the step. */
  inputs?: Record<string, unknown>;
  /** Final verdict (auto-'fail' on throw, auto-'skip' when gated/declined). */
  status: Verdict;
  /** Wall-free monotonic duration, milliseconds. */
  durationMs: number;
  /** ISO timestamp the step started (passed in by the caller). */
  startedAt?: string;
  /** JSON.stringify of the result, truncated. */
  outputPreview: string;
  /** Whether outputPreview was truncated. */
  outputTruncated?: boolean;
  /** Error message + first stack line, when the action threw. */
  error?: string;
  /** Whether the action threw (vs. returned but human marked wrong). */
  threw?: boolean;
  /** Screenshot path relative to the results dir, when captured. */
  screenshot?: string;
  /** Free-text notes from the human. */
  notes: string;
  /** Source file to fix, when known (mirrors Step.sourceHint). */
  sourceHint?: string;
}

// ---------------------------------------------------------------------------
// Scenario modules
// ---------------------------------------------------------------------------

/** Context handed to a scenario's `run()`. */
export interface ScenarioCtx {
  driver: LinkedInDriver;
  targets: TestTargets;
  options: CliOptions;
  runner: import('./runner').Runner;
  /**
   * The per-step execution context the Runner needs (live page, results dir,
   * artifact sink). Built once by index.ts and threaded into every
   * `runner.runReadOnly` / `runner.runMutating` call so scenarios never assemble
   * it (and never touch the Page / fs) themselves.
   */
  rc: RunContext;
}

/**
 * A scenario file exports one of these. `run()` simply sequences
 * `runner.runStep(...)` calls; all safety gating and reporting is centralized in
 * the Runner so it cannot be bypassed per-scenario.
 */
export interface ScenarioModule {
  id: string;
  label: string;
  group: ScenarioGroup;
  run(ctx: ScenarioCtx): Promise<void>;
}
