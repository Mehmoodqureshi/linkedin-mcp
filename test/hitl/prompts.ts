/**
 * Readline-based async prompt helpers for the HITL harness.
 *
 * A single shared readline interface is created lazily and reused for every
 * prompt; `closeReadline()` tears it down on teardown. Colours are emitted as
 * raw ANSI codes so the harness pulls in no `chalk`-style dependency.
 *
 * Discipline: prompts are user-facing and therefore written to STDOUT (the
 * report path is the only other stdout consumer); diagnostic logging elsewhere
 * in the harness goes to stderr.
 */

import * as readline from 'readline';

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const color = (code: string, s: string): string => `${code}${s}${RESET}`;

/** Public colourisers, handy for callers building their own prompt strings. */
export const colors = {
  pass: (s: string): string => color(GREEN, s),
  fail: (s: string): string => color(RED, s),
  skip: (s: string): string => color(YELLOW, s),
  question: (s: string): string => color(CYAN, s),
  bold: (s: string): string => color(BOLD, s),
};

// ---------------------------------------------------------------------------
// Shared readline interface
// ---------------------------------------------------------------------------

let rl: readline.Interface | null = null;
let rlClosed = false;

function getReadline(): readline.Interface {
  // Recreate if we never had one, or the previous interface closed (EOF).
  if (!rl || rlClosed) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rlClosed = false;
    rl.once('close', () => {
      rlClosed = true;
    });
  }
  return rl;
}

/** Close and drop the shared readline interface. Safe to call repeatedly. */
export function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// ---------------------------------------------------------------------------
// Core prompts
// ---------------------------------------------------------------------------

/**
 * Free-text prompt. Resolves with the trimmed answer.
 *
 * Degrades gracefully when stdin is closed / non-interactive (piped, no TTY,
 * EOF): instead of throwing `readline was closed`, it resolves with an empty
 * string. For the login gate this reads as "not logged in" and the run aborts
 * cleanly rather than crashing with a stack trace.
 */
export function ask(question: string): Promise<string> {
  const iface = getReadline();
  return new Promise<string>((resolve) => {
    let done = false;
    const onClose = (): void => {
      if (!done) {
        done = true;
        resolve('');
      }
    };
    iface.once('close', onClose);
    try {
      iface.question(colors.question(question), (answer) => {
        done = true;
        iface.removeListener('close', onClose);
        resolve(answer.trim());
      });
    } catch {
      // Interface already closed before we could ask (EOF) — empty answer.
      onClose();
    }
  });
}

/**
 * Yes/no confirmation, defaulting to NO. Only a literal `y`/`yes`
 * (case-insensitive) confirms; everything else declines.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} ${colors.bold('[y/N]')} `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * Strict confirmation for mutating actions: requires the literal word `yes`.
 * Anything else (including a bare `y`) counts as a decline.
 */
export async function confirmYes(label: string): Promise<boolean> {
  const answer = await ask(
    `${colors.fail(colors.bold(label))} ${colors.bold("type 'yes' to proceed:")} `,
  );
  return answer === 'yes';
}

/**
 * Prompt for a pass/fail/skip verdict followed by optional free-text notes.
 * Repeats until a recognised verdict is entered.
 */
export async function verdict(): Promise<{ result: Verdict; notes: string }> {
  let result: Verdict | null = null;

  while (result === null) {
    const raw = (
      await ask(
        `verdict ${colors.pass('[p]ass')} / ${colors.fail('[f]ail')} / ${colors.skip(
          '[s]kip',
        )}: `,
      )
    ).toLowerCase();

    if (raw === 'p' || raw === 'pass') result = 'pass';
    else if (raw === 'f' || raw === 'fail') result = 'fail';
    else if (raw === 's' || raw === 'skip') result = 'skip';
    else {
      process.stdout.write(
        colors.skip("  please enter 'p', 'f' or 's'.\n"),
      );
    }
  }

  const notes = await ask('notes (optional, Enter to skip): ');
  return { result, notes };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { Verdict } from './types';
