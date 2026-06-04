/**
 * QuotaManager — per-day caps on mutating LinkedIn actions.
 *
 * LinkedIn enforces hard limits on automation-shaped behaviour (invites,
 * messages, reactions). Tripping them risks a temporary — or permanent —
 * restriction on the account. This module tracks how many of each mutating
 * action we've performed today and refuses to exceed conservative daily caps,
 * BEFORE the action runs, so the driver fails safe instead of getting the user
 * flagged.
 *
 * Counts persist to `userData/linkedin-quota.json` and reset at local midnight
 * (keyed by calendar date). The caps are intentionally below LinkedIn's real
 * thresholds to leave headroom for the user's own manual activity.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/** The mutating actions we meter. Reads are never quota-limited. */
export type QuotaAction = 'connection' | 'message' | 'reaction' | 'comment';

/**
 * Conservative daily ceilings. LinkedIn's real limits are higher and fuzzy
 * (e.g. ~100–200 invites/week, message throttles that vary by account age);
 * these leave deliberate headroom. Tune via env if needed.
 */
const DEFAULT_CAPS: Record<QuotaAction, number> = {
  connection: 40,
  message: 60,
  reaction: 150,
  comment: 30,
};

/** Thrown when an action would exceed its daily cap. */
export class QuotaError extends Error {
  readonly code = 'quota_exceeded';
  constructor(
    public readonly action: QuotaAction,
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(
      `Daily ${action} limit reached (${used}/${cap}). This cap protects the ` +
        `account from LinkedIn automation restrictions; it resets at midnight.`,
    );
    this.name = 'QuotaError';
  }
}

interface QuotaState {
  /** Local calendar date the counts belong to, `YYYY-MM-DD`. */
  date: string;
  counts: Partial<Record<QuotaAction, number>>;
}

/** Resolve userData (lazy/defensive, matching SessionManager). */
function resolveUserDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as typeof import('electron');
    if (electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    /* not in Electron */
  }
  return (
    process.env.LINKEDIN_MCP_USERDATA ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.linkedin-mcp')
  );
}

function today(): string {
  // Local-date key (YYYY-MM-DD). Resets at the user's local midnight.
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function capFor(action: QuotaAction): number {
  const envKey = `LINKEDIN_CAP_${action.toUpperCase()}`;
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CAPS[action];
}

export class QuotaManager {
  public readonly path: string;
  private state: QuotaState | null = null;

  constructor(quotaPath: string = join(resolveUserDataDir(), 'linkedin-quota.json')) {
    this.path = quotaPath;
  }

  /** Load (and roll over if the date changed) the persisted counts. */
  private async ensureLoaded(): Promise<QuotaState> {
    if (this.state && this.state.date === today()) return this.state;

    let loaded: QuotaState | null = null;
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as QuotaState;
      if (parsed && typeof parsed.date === 'string' && parsed.counts) loaded = parsed;
    } catch {
      /* missing/corrupt — start fresh */
    }

    if (!loaded || loaded.date !== today()) {
      loaded = { date: today(), counts: {} };
    }
    this.state = loaded;
    return loaded;
  }

  /** Throw {@link QuotaError} if performing `action` now would exceed its cap. */
  public async enforce(action: QuotaAction): Promise<void> {
    const state = await this.ensureLoaded();
    const used = state.counts[action] ?? 0;
    const cap = capFor(action);
    if (used >= cap) throw new QuotaError(action, used, cap);
  }

  /** Record one successful `action`, persisting the new count. */
  public async record(action: QuotaAction): Promise<void> {
    const state = await this.ensureLoaded();
    state.counts[action] = (state.counts[action] ?? 0) + 1;
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.writeFile(this.path, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Non-fatal: an unwritable quota file must not block the action that
      // already succeeded; we just lose durability of the count.
    }
  }

  /** Run a mutating action under its cap: enforce → run → record. */
  public async guard<T>(action: QuotaAction, fn: () => Promise<T>): Promise<T> {
    await this.enforce(action);
    const result = await fn();
    await this.record(action);
    return result;
  }

  /** Today's usage vs caps, for the UI / status surface. */
  public async snapshot(): Promise<Array<{ action: QuotaAction; used: number; cap: number }>> {
    const state = await this.ensureLoaded();
    return (Object.keys(DEFAULT_CAPS) as QuotaAction[]).map((action) => ({
      action,
      used: state.counts[action] ?? 0,
      cap: capFor(action),
    }));
  }
}

let singleton: QuotaManager | null = null;

/** Process-wide QuotaManager singleton. */
export function getQuotaManager(): QuotaManager {
  if (!singleton) singleton = new QuotaManager();
  return singleton;
}
