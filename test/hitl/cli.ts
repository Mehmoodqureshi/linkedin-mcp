/**
 * cli.ts — argument parsing for the HITL harness.
 *
 * Supported flags:
 *   --only <csv>          run only the named scenario groups (e.g. --only profile,search)
 *   --include-mutating    opt in to MUTATING steps (off by default; default run is read-only)
 *   --headed              force a visible browser (default — HITL requires headed)
 *   --headless            override to a headless browser (NOT recommended; mutations not observable)
 *   --help, -h            print usage and exit
 *
 * parseArgs never throws on unknown flags — it ignores them so the harness stays
 * forgiving; --help/-h is detected by the caller (it returns `help: true`).
 */

export interface CliOptions {
  /** Scenario groups to run, or null for "all". Lower-cased, de-duplicated. */
  only: string[] | null;
  /** Whether MUTATING steps are allowed to execute (still per-step gated). */
  includeMutating: boolean;
  /** Whether the browser runs headed. HITL forces this true unless --headless. */
  headed: boolean;
  /** True when --help/-h was passed; caller should printHelp() and exit(0). */
  help: boolean;
}

const USAGE = `
LinkedIn MCP — HITL (human-in-the-loop) test harness

Usage:
  npm run test:hitl -- [options]

Options:
  --only <csv>          Run only these scenario groups (comma-separated).
                        Groups: auth, profile, search, messages, connections, feed
                        e.g. --only profile,search
  --include-mutating    Opt in to MUTATING actions (sendMessage, sendConnectionRequest,
                        acceptConnectionRequest, withdrawConnectionRequest, likePost,
                        reactToPost, commentOnPost, logout).
                        OFF by default. Even when set, every mutating step requires a
                        per-step typed 'yes' confirmation against a config-supplied target.
  --headed              Run with a visible browser window (default; required for HITL).
  --headless            Run without a visible window (override; mutations not observable).
  --help, -h            Show this help and exit.

Examples:
  npm run test:hitl -- --only profile,search
  npm run test:hitl -- --only connections --include-mutating

Before running:
  1. Copy test-targets.example.json to test-targets.json (project root).
  2. Fill in the targets for the suites you want to run.
  3. A visible browser opens; log in if prompted, then press Enter.
`.trimStart();

/**
 * Parse process argv (already sliced of node + script, or pass process.argv.slice(2)).
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    only: null,
    includeMutating: false,
    // HITL defaults to headed; --headless flips it.
    headed: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;

      case '--include-mutating':
        opts.includeMutating = true;
        break;

      case '--headed':
        opts.headed = true;
        break;

      case '--headless':
        opts.headed = false;
        break;

      case '--only': {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          opts.only = parseOnly(next);
          i++; // consume the value
        } else {
          opts.only = [];
        }
        break;
      }

      default: {
        // Support --only=profile,search form too.
        if (arg.startsWith('--only=')) {
          opts.only = parseOnly(arg.slice('--only='.length));
        }
        // Unknown flags are ignored deliberately.
        break;
      }
    }
  }

  return opts;
}

function parseOnly(csv: string): string[] {
  const groups = csv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  // De-duplicate while preserving order.
  return Array.from(new Set(groups));
}

export function printHelp(): void {
  process.stdout.write(USAGE + '\n');
}
