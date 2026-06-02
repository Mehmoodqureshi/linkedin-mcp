/**
 * reporter.ts — emits the two run artifacts and the terminal tally.
 *
 *   report.json  full structured StepResult[] + run metadata (machine-readable)
 *   report.md    human-readable tuning report: summary table + FAILURES & TUNING HINTS
 *                grouped by the src/driver/actions/*.ts file to edit.
 *
 * Both artifacts derive from the SAME StepResult[] so they can never drift.
 * Logs go to stderr; only the written-path notice goes to stdout (MCP-stdout
 * discipline). printSummary prints a colored pass/fail/skip tally at the end.
 *
 * Note on "errors": a StepResult has no dedicated 'error' status — an action
 * that threw is recorded as status 'fail' with `threw: true` and an `error`
 * string. The report surfaces those as ERROR-flavoured failures.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StepResult } from './types';

export interface ReportMeta {
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** Total wall-clock duration of the run, ms. */
  durationMs: number;
  /** Scenario groups that were selected for this run. */
  suites: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write report.json and report.md into resultsDir. Notes the written paths to
 * stdout so a calling script can capture them.
 */
export function writeReport(
  resultsDir: string,
  results: StepResult[],
  meta: ReportMeta,
): void {
  fs.mkdirSync(resultsDir, { recursive: true });

  const counts = tally(results);
  const finishedAt = new Date(
    new Date(meta.startedAt).getTime() + meta.durationMs,
  ).toISOString();

  const jsonDoc = {
    run: {
      startedAt: meta.startedAt,
      finishedAt,
      durationMs: meta.durationMs,
      suites: meta.suites,
      counts,
    },
    steps: results,
  };

  const jsonPath = path.join(resultsDir, 'report.json');
  const mdPath = path.join(resultsDir, 'report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(jsonDoc, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(results, meta, counts, finishedAt), 'utf8');

  process.stdout.write(`\nReport written:\n  ${mdPath}\n  ${jsonPath}\n`);
}

/**
 * Print a colored pass/fail/skip tally to the terminal (stderr).
 */
export function printSummary(results: StepResult[]): void {
  const counts = tally(results);
  const errored = results.filter(threw).length;
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('=== HITL run summary ==='));
  lines.push(`  total : ${counts.total}`);
  lines.push(`  ${green('pass ')}: ${counts.pass}`);
  lines.push(
    `  ${red('fail ')}: ${counts.fail}` +
      (errored > 0 ? ` (${errored} threw)` : ''),
  );
  lines.push(`  ${yellow('skip ')}: ${counts.skip}`);
  lines.push('');

  if (counts.fail > 0) {
    lines.push(
      red(
        `${counts.fail} step(s) need tuning — see "FAILURES & TUNING HINTS" in report.md`,
      ),
    );
  } else {
    lines.push(green('No failures.'));
  }
  lines.push('');
  process.stderr.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

interface Counts {
  total: number;
  pass: number;
  fail: number;
  skip: number;
}

function tally(results: StepResult[]): Counts {
  const c: Counts = { total: results.length, pass: 0, fail: 0, skip: 0 };
  for (const r of results) {
    if (r.status === 'pass') c.pass++;
    else if (r.status === 'fail') c.fail++;
    else if (r.status === 'skip') c.skip++;
  }
  return c;
}

function threw(r: StepResult): boolean {
  return r.threw === true;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(
  results: StepResult[],
  meta: ReportMeta,
  counts: Counts,
  finishedAt: string,
): string {
  const out: string[] = [];

  out.push('# HITL Tuning Report');
  out.push('');
  out.push(`- started: \`${meta.startedAt}\``);
  out.push(`- finished: \`${finishedAt}\``);
  out.push(`- duration: ${formatDuration(meta.durationMs)}`);
  out.push(`- suites: ${meta.suites.length ? meta.suites.join(', ') : 'all'}`);
  out.push('');

  // Summary counts table.
  out.push('## Summary');
  out.push('');
  out.push('| total | pass | fail | skip |');
  out.push('|------:|-----:|-----:|-----:|');
  out.push(`| ${counts.total} | ${counts.pass} | ${counts.fail} | ${counts.skip} |`);
  out.push('');
  if (counts.fail > 0) {
    out.push(`> **${counts.fail} failing step(s)** — see the Tuning section below.`);
  } else {
    out.push('> No failing steps.');
  }
  out.push('');

  // Results table.
  out.push('## Results');
  out.push('');
  out.push('| Suite | Step | Status | Duration | Screenshot | Notes |');
  out.push('|-------|------|--------|---------:|------------|-------|');
  for (const r of results) {
    out.push(
      `| ${cell(r.group ?? '')} | ${cell(stepLabel(r))} | ${statusText(r)} | ` +
        `${formatDuration(r.durationMs)} | ${screenshotCell(r)} | ${cell(r.notes)} |`,
    );
  }
  out.push('');

  // Tuning section — only when there are failures.
  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    out.push('## FAILURES & TUNING HINTS');
    out.push('');
    out.push(
      'Failures are grouped by the source file to edit, so one tuning pass = one file open.',
    );
    out.push('');

    for (const [sourceFile, group] of groupBySourceFile(failures)) {
      out.push(`### \`${sourceFile}\``);
      out.push('');
      for (const r of group) {
        out.push(`#### ${threw(r) ? 'ERROR' : 'FAIL'}: ${stepLabel(r)}`);
        out.push('');
        out.push(`- likely cause: ${refinedHint(r)}`);
        if (r.inputs && Object.keys(r.inputs).length > 0) {
          out.push(`- inputs: \`${safeStringify(r.inputs)}\``);
        }
        if (r.error) {
          out.push('- error:');
          out.push('');
          out.push('  ```');
          out.push(indent(r.error, '  '));
          out.push('  ```');
        }
        if (r.outputPreview) {
          out.push(`- captured output${r.outputTruncated ? ' (truncated)' : ''}:`);
          out.push('');
          out.push('  ```');
          out.push(indent(r.outputPreview, '  '));
          out.push('  ```');
        }
        if (r.screenshot) out.push(`- screenshot: \`${r.screenshot}\``);
        if (r.notes) out.push(`- human notes: ${r.notes}`);
        out.push('');
      }
    }
  }

  // Skipped section so gated/unconfigured steps aren't mistaken for passes.
  const skipped = results.filter((r) => r.status === 'skip');
  if (skipped.length > 0) {
    out.push('## Skipped');
    out.push('');
    out.push('These steps were gated or unconfigured (not passes):');
    out.push('');
    for (const r of skipped) {
      out.push(`- ${stepLabel(r)}${r.notes ? ` — ${r.notes}` : ''}`);
    }
    out.push('');
  }

  return out.join('\n') + '\n';
}

/**
 * Group failures by the source file the tuning hint points at, so the report is
 * organized by the file to edit. Steps with no sourceHint fall under an
 * "(unknown source)" bucket.
 */
function groupBySourceFile(failures: StepResult[]): Map<string, StepResult[]> {
  const map = new Map<string, StepResult[]>();
  for (const r of failures) {
    const file = r.sourceHint ?? '(unknown source)';
    const bucket = map.get(file);
    if (bucket) bucket.push(r);
    else map.set(file, [r]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function stepLabel(r: StepResult): string {
  return r.action ?? r.name;
}

/**
 * Refine the base tuning hint with whether the action threw vs. returned a value
 * the human judged wrong, so the next tuning pass knows where to look.
 */
function refinedHint(r: StepResult): string {
  const base = r.sourceHint
    ? `selectors/actions in ${r.sourceHint} likely drifted`
    : 'selectors/actions for this step likely drifted';
  if (threw(r)) {
    return `${base} (threw — check navigation/auth guard + selector existence)`;
  }
  return `${base} (returned — selectors matched stale/incorrect nodes, verify normalized shape)`;
}

// ---------------------------------------------------------------------------
// Cell + text helpers
// ---------------------------------------------------------------------------

function statusText(r: StepResult): string {
  switch (r.status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return threw(r) ? 'FAIL (threw)' : 'FAIL';
    case 'skip':
      return 'SKIP';
    default:
      return String(r.status).toUpperCase();
  }
}

function screenshotCell(r: StepResult): string {
  return r.screenshot ? `\`${r.screenshot}\`` : '—';
}

/** Escape pipes/newlines so table cells never break the markdown grid. */
function cell(text: string): string {
  const trimmed = text.replace(/\r?\n/g, ' ').trim();
  const escaped = trimmed.replace(/\|/g, '\\|');
  return escaped.length > 0 ? escaped : '—';
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// ANSI color (terminal only). Disabled when not a TTY or NO_COLOR is set.
// ---------------------------------------------------------------------------

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && Boolean(process.stderr.isTTY);
}

function wrap(code: string, text: string): string {
  return colorEnabled() ? `[${code}m${text}[0m` : text;
}

function green(t: string): string {
  return wrap('32', t);
}
function red(t: string): string {
  return wrap('31', t);
}
function yellow(t: string): string {
  return wrap('33', t);
}
function bold(t: string): string {
  return wrap('1', t);
}
