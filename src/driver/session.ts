/**
 * SessionManager — persistence + validation of the LinkedIn Playwright session.
 *
 * The persistent Chromium profile (owned by BrowserManager) is the primary
 * session mechanism: cookies, localStorage and IndexedDB all live on disk in
 * the profile directory and survive app restarts on their own.
 *
 * This module adds a SECOND layer on top of that profile: a portable,
 * inspectable `storageState` artifact written to
 * `app.getPath('userData')/linkedin-session.json`. It gives us:
 *
 *   (a) a fast, browser-free way to answer "are we logged in?" by inspecting
 *       the `li_at` cookie + its expiry, without launching Chromium;
 *   (b) a recovery path: if the persistent profile is corrupted we can launch a
 *       fresh context and re-inject cookies via `context.addCookies(...)`;
 *   (c) a stable, human-inspectable session file for debugging.
 *
 * Everything here is defensive: a missing / malformed file is treated as "no
 * session" rather than an error, so a first run (no file yet) and a corrupted
 * file both degrade gracefully to the manual-login flow.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrowserContext } from 'playwright';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the userData directory. We import Electron lazily / defensively so
 * this module can also be unit-tested or used in a plain Node context (e.g. a
 * registration script) where `electron` may not have an `app` available yet.
 */
function resolveUserDataDir(): string {
  try {
    // Avoid a static import so non-Electron contexts don't blow up at load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as typeof import('electron');
    const app = electron.app;
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // Not running inside Electron — fall through to an env/temp fallback.
  }

  const fallback =
    process.env.LINKEDIN_MCP_USERDATA ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.linkedin-mcp');
  return fallback;
}

/** Absolute path to the persisted storageState artifact. */
export const SESSION_PATH: string = join(resolveUserDataDir(), 'linkedin-session.json');

/** Cookie name that proves an authenticated LinkedIn session. */
const LINKEDIN_AUTH_COOKIE = 'li_at';

/** Domains we consider "LinkedIn" when scanning the storageState cookies. */
const LINKEDIN_DOMAIN_RE = /(^|\.)linkedin\.com$/i;

// ---------------------------------------------------------------------------
// storageState shape (a structural subset of Playwright's type)
// ---------------------------------------------------------------------------

/** A single cookie inside a Playwright storageState. */
export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix epoch seconds; `-1` (or absent) means a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** Per-origin localStorage captured by Playwright's storageState. */
export interface StorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/** The full storageState document Playwright reads/writes. */
export interface StorageState {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

/** Result of {@link SessionManager.isValid}. */
export interface SessionValidity {
  /** True when a non-expired `li_at` LinkedIn cookie is present. */
  valid: boolean;
  /** Reason the session is invalid, for logging / re-auth prompts. */
  reason?: 'no_file' | 'malformed' | 'no_auth_cookie' | 'expired';
  /** Unix epoch seconds the `li_at` cookie expires at, when known. */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  /** Absolute path to the storageState file. */
  public readonly path: string;

  /**
   * In-memory cache of the last-read/last-written state, so repeated
   * `isValid()` checks don't hit disk on every call.
   */
  private cache: StorageState | null = null;

  constructor(sessionPath: string = SESSION_PATH) {
    this.path = sessionPath;
  }

  // -- Persistence --------------------------------------------------------

  /**
   * Export the live browser context's storageState to disk.
   *
   * Called after a successful login (and optionally on graceful close) so the
   * portable artifact stays in sync with the persistent profile.
   */
  public async save(context: BrowserContext): Promise<StorageState> {
    await this.ensureDir();

    // Playwright writes the file itself when given `path`; we also capture the
    // returned value to refresh our in-memory cache.
    const state = (await context.storageState({ path: this.path })) as StorageState;
    this.cache = state;
    return state;
  }

  /**
   * Load the persisted storageState from disk.
   *
   * Returns `null` when the file is absent or unparseable — callers should
   * treat that as "no session" and fall back to the manual-login flow rather
   * than surfacing an error.
   */
  public async load(): Promise<StorageState | null> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!this.isStorageState(parsed)) {
        return null;
      }
      this.cache = parsed;
      return parsed;
    } catch {
      // ENOENT (first run) or JSON parse failure (corrupted) — both => no session.
      return null;
    }
  }

  /**
   * Delete the persisted session artifact (logout / reset). Clearing the file
   * is idempotent: a missing file is treated as success.
   */
  public async clear(): Promise<void> {
    this.cache = null;
    try {
      await fs.rm(this.path, { force: true });
    } catch (err) {
      // `force: true` already swallows ENOENT; anything else is a real problem.
      throw new Error(
        `Failed to clear session file at ${this.path}: ${(err as Error).message}`,
      );
    }
  }

  // -- Validation ---------------------------------------------------------

  /**
   * Cheap, browser-free check of session validity.
   *
   * Reads the persisted storageState (preferring the in-memory cache) and
   * confirms a non-expired LinkedIn `li_at` cookie exists. This does NOT launch
   * Chromium — for an authoritative liveness check (detecting a server-side
   * revoked session) the caller should additionally navigate to `/feed` and
   * watch for a redirect to `/login`.
   */
  public async isValid(): Promise<SessionValidity> {
    const state = this.cache ?? (await this.load());
    if (!state) {
      return { valid: false, reason: 'no_file' };
    }
    if (!Array.isArray(state.cookies)) {
      return { valid: false, reason: 'malformed' };
    }

    const authCookie = state.cookies.find(
      (c) => c.name === LINKEDIN_AUTH_COOKIE && LINKEDIN_DOMAIN_RE.test(c.domain),
    );
    if (!authCookie) {
      return { valid: false, reason: 'no_auth_cookie' };
    }

    // `expires === -1` denotes a session cookie (no expiry) — treat as valid.
    if (authCookie.expires !== -1) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (authCookie.expires <= nowSeconds) {
        return { valid: false, reason: 'expired', expiresAt: authCookie.expires };
      }
      return { valid: true, expiresAt: authCookie.expires };
    }

    return { valid: true };
  }

  /**
   * Convenience boolean wrapper around {@link isValid}.
   */
  public async hasValidSession(): Promise<boolean> {
    return (await this.isValid()).valid;
  }

  /**
   * The cookies array from the persisted state, for recovery re-injection via
   * `context.addCookies(...)`. Returns an empty array when there is no session.
   */
  public async getCookies(): Promise<StorageCookie[]> {
    const state = this.cache ?? (await this.load());
    return state?.cookies ?? [];
  }

  // -- Internals ----------------------------------------------------------

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
  }

  /** Narrow an arbitrary parsed JSON value to a structurally-valid StorageState. */
  private isStorageState(value: unknown): value is StorageState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return Array.isArray(v.cookies) && Array.isArray(v.origins);
  }
}

/** A process-wide singleton, mirroring the single-session driver model. */
let singleton: SessionManager | null = null;

/** Get (or lazily create) the shared SessionManager instance. */
export function getSessionManager(): SessionManager {
  if (!singleton) {
    singleton = new SessionManager();
  }
  return singleton;
}
