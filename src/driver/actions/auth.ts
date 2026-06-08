/**
 * Authentication actions for the LinkedIn driver.
 *
 * Session model:
 *   - We run Playwright with a *persistent* browser context (a profile dir),
 *     so cookies and local storage survive process restarts on their own.
 *   - On top of that we also persist a portable `storageState.json` snapshot so
 *     a fresh/headless context can be hydrated without the full profile.
 *   - Authentication is validated by the presence (and non-expiry) of the
 *     `li_at` cookie, which is LinkedIn's primary auth token.
 *
 * Login is intentionally MANUAL/headed-first: we open `/login`, optionally
 * pre-fill credentials, and then wait for the human to clear 2FA / captcha
 * before persisting the session. We never store the password.
 */

import { promises as fs } from 'node:fs';
import type { BrowserContext, Cookie, Page } from 'playwright';

import {
  LINKEDIN_BASE,
  NeedsLoginError,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a login attempt. */
export interface LoginResult {
  success: boolean;
  /** True if a 2FA / captcha / checkpoint challenge was detected mid-flow. */
  challengeDetected: boolean;
  /** UNIX-epoch ms expiry of the li_at cookie, if known. */
  cookieExpiry?: number;
  message: string;
}

/** Normalized authentication status. */
export interface AuthStatus {
  authenticated: boolean;
  /** Whether a li_at cookie exists in the active context. */
  hasSessionCookie: boolean;
  /** UNIX-epoch ms expiry of li_at, if present. */
  cookieExpiry?: number;
  /** Whether the on-disk storageState file exists. */
  hasStoredSession: boolean;
}

/** Constructor options carrying filesystem locations for persisted state. */
export interface AuthPaths {
  /** Path to the portable storageState.json snapshot. */
  storageStatePath: string;
  /** Path to the persistent browser profile directory. */
  profileDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Finds the li_at auth cookie among a cookie list. */
function findLiAt(cookies: readonly Cookie[]): Cookie | undefined {
  return cookies.find((c) => c.name === 'li_at');
}

/**
 * A li_at cookie is "valid" if it exists and either has no expiry (session
 * cookie) or its expiry is in the future. Playwright reports `expires` in
 * seconds (-1 means session cookie).
 */
function isCookieValid(cookie: Cookie | undefined): boolean {
  if (!cookie) return false;
  if (cookie.expires === -1) return true; // session cookie
  return cookie.expires * 1000 > Date.now();
}

/** li_at expiry as epoch-ms, or undefined for session/absent cookies. */
function cookieExpiryMs(cookie: Cookie | undefined): number | undefined {
  if (!cookie || cookie.expires === -1) return undefined;
  return Math.floor(cookie.expires * 1000);
}

/**
 * Builds an `{ cookieExpiry }` fragment only when an expiry is known. Returns an
 * empty object otherwise, so spreading it satisfies `exactOptionalPropertyTypes`
 * (the property is genuinely absent rather than `undefined`).
 */
function expiryField(cookie: Cookie | undefined): { cookieExpiry?: number } {
  const ms = cookieExpiryMs(cookie);
  return ms !== undefined ? { cookieExpiry: ms } : {};
}

// ---------------------------------------------------------------------------
// AuthActions
// ---------------------------------------------------------------------------

export class AuthActions {
  private readonly page: Page;
  private readonly paths: AuthPaths;

  /**
   * @param page  The active Playwright page (owned by the persistent context).
   * @param paths Filesystem locations for the storageState snapshot + profile.
   *              Optional so the class can be constructed with just a Page
   *              (paths fall back to cwd-relative defaults).
   */
  constructor(page: Page, paths?: Partial<AuthPaths>) {
    this.page = page;
    this.paths = {
      storageStatePath: paths?.storageStatePath ?? 'storageState.json',
      profileDir: paths?.profileDir ?? '.linkedin-profile',
    };
  }

  /** The browser context backing the active page. */
  private get context(): BrowserContext {
    return this.page.context();
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  /**
   * Drives the headed manual-login flow.
   *
   * 1. Navigates to `linkedin.com/login`.
   * 2. Pre-fills email/password if provided (the human may still need to solve
   *    2FA or a captcha by hand).
   * 3. Detects a 2FA / checkpoint challenge and waits patiently for it.
   * 4. Waits for the `/feed` redirect (or a li_at cookie) as the success signal.
   * 5. Persists the storageState snapshot.
   *
   * The password is used transiently to fill the form and is never stored.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    await navigate(this.page, `${LINKEDIN_BASE}/login`);

    // If we were already logged in, /login bounces straight to /feed.
    if (this.page.url().includes('/feed')) {
      await this.saveSession();
      const cookie = findLiAt(await this.context.cookies());
      return {
        success: true,
        challengeDetected: false,
        ...expiryField(cookie),
        message: 'Already authenticated; existing session reused.',
      };
    }

    // Fill credentials when supplied. Selectors target the stable input ids
    // LinkedIn has used for years, with name-based fallbacks.
    if (email) {
      const emailInput = this.page
        .locator('#username, input[name="session_key"], input[autocomplete="username"]')
        .first();
      if (await emailInput.count()) {
        await emailInput.fill(email);
        await sleep(400);
      }
    }
    if (password) {
      const pwInput = this.page
        .locator('#password, input[name="session_password"], input[type="password"]')
        .first();
      if (await pwInput.count()) {
        await pwInput.fill(password);
        await sleep(400);
      }
    }

    // Submit if both fields were filled. Otherwise leave it to the human.
    if (email && password) {
      const submit = this.page
        .locator('button[type="submit"], button[aria-label="Sign in"], button[data-litms-control-urn]')
        .first();
      if (await submit.count()) {
        await rateLimitDelay();
        await submit.click().catch(() => undefined);
      }
    }

    // Now wait for one of: feed redirect (success), or a challenge page that
    // the human must resolve manually. We poll for up to ~5 minutes to give
    // the user time to complete 2FA/captcha.
    const deadline = Date.now() + 5 * 60_000;
    let challengeDetected = false;

    while (Date.now() < deadline) {
      const url = this.page.url();

      if (url.includes('/feed')) {
        break; // success
      }

      // A li_at cookie can appear before the SPA finishes routing to /feed.
      const cookie = findLiAt(await this.context.cookies());
      if (isCookieValid(cookie)) break;

      if (
        url.includes('/checkpoint') ||
        url.includes('/challenge') ||
        (await this.page
          .locator('input[name="pin"], #input__phone_verification_pin, [data-test-id="captcha"]')
          .count()) > 0
      ) {
        challengeDetected = true;
      }

      await sleep(2000);
    }

    const cookie = findLiAt(await this.context.cookies());
    const success = isCookieValid(cookie) || this.page.url().includes('/feed');

    if (success) {
      await this.saveSession();
    }

    return {
      success,
      challengeDetected,
      ...expiryField(cookie),
      message: success
        ? 'Login succeeded; session persisted.'
        : challengeDetected
          ? 'A 2FA/captcha challenge was not completed in time.'
          : 'Login did not complete (no valid li_at cookie was set).',
    };
  }

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  /**
   * Logs out by clearing the persistent context's cookies and deleting the
   * on-disk storageState snapshot. We also best-effort navigate to LinkedIn's
   * logout endpoint so the server invalidates the session token.
   */
  async logout(): Promise<{ success: boolean; message: string }> {
    // Server-side logout (best effort; ignore failures).
    try {
      await navigate(this.page, `${LINKEDIN_BASE}/m/logout/`);
      await rateLimitDelay();
    } catch {
      // offline / already logged out — continue with local teardown
    }

    // Clear cookies from the live persistent profile.
    try {
      await this.context.clearCookies();
    } catch {
      // ignore
    }

    // Delete the portable snapshot.
    await fs.rm(this.paths.storageStatePath, { force: true }).catch(() => undefined);

    return { success: true, message: 'Session cookies cleared and snapshot removed.' };
  }

  // -------------------------------------------------------------------------
  // isLoggedIn
  // -------------------------------------------------------------------------

  /**
   * Returns true when the active session is authenticated. Fast path: a valid
   * li_at cookie. Slow path: confirm the primary nav element rendered (i.e. we
   * were not bounced to the auth wall).
   *
   * `navigate` (default true) controls the slow path. When false we inspect the
   * page exactly where it sits — never issuing a goto. This is required for
   * callers driven by navigation events (the embedded view's auth re-check):
   * a forced /feed navigation there would fire another navigation event and
   * loop the browser reloading endlessly.
   */
  async isLoggedIn(opts: { navigate?: boolean } = {}): Promise<boolean> {
    const cookie = findLiAt(await this.context.cookies());
    if (isCookieValid(cookie)) return true;

    // Cookie missing/expired — verify against the live page as a fallback.
    try {
      if (opts.navigate !== false) {
        await navigate(this.page, `${LINKEDIN_BASE}/feed/`);
      }
      const url = this.page.url();
      if (url.includes('/login') || url.includes('authwall')) {
        return false;
      }
      // LinkedIn hashes its class names and dropped the old #global-nav /
      // aria-label="Primary Navigation" hooks, so key off stable href targets
      // instead: the logged-in global nav always links to My Network / Messaging
      // / Notifications, and logged-out pages (authwall/login) never do.
      const nav = this.page
        .locator('a[href*="/mynetwork"], a[href*="/messaging"], a[href*="/notifications/"]')
        .first();
      return (await nav.count()) > 0;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // status (normalized snapshot for diagnostics)
  // -------------------------------------------------------------------------

  /** Normalized auth status, combining live cookie state and on-disk session. */
  async status(): Promise<AuthStatus> {
    const cookie = findLiAt(await this.context.cookies());
    const valid = isCookieValid(cookie);
    const hasStored = await fs
      .stat(this.paths.storageStatePath)
      .then(() => true)
      .catch(() => false);

    const expiry = cookieExpiryMs(cookie);
    return {
      authenticated: valid,
      hasSessionCookie: Boolean(cookie),
      ...(expiry !== undefined ? { cookieExpiry: expiry } : {}),
      hasStoredSession: hasStored,
    };
  }

  // -------------------------------------------------------------------------
  // restoreSession
  // -------------------------------------------------------------------------

  /**
   * Hydrates a context from the persisted storageState snapshot by injecting
   * its cookies into the supplied (or active) context. Returns true if a valid
   * li_at cookie was restored.
   *
   * Note: the canonical Playwright pattern is to pass `storageState` at context
   * creation; this method exists for the case where the context already exists
   * (the persistent profile) and we want to top it up from the snapshot.
   */
  async restoreSession(context?: BrowserContext): Promise<boolean> {
    const target = context ?? this.context;

    let raw: string;
    try {
      raw = await fs.readFile(this.paths.storageStatePath, 'utf8');
    } catch {
      throw new NeedsLoginError('No stored session snapshot found.');
    }

    const parsed = JSON.parse(raw) as {
      cookies?: Cookie[];
      origins?: unknown[];
    };

    if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
      await target.addCookies(parsed.cookies);
    }

    const cookie = findLiAt(await target.cookies());
    return isCookieValid(cookie);
  }

  // -------------------------------------------------------------------------
  // saveSession (internal)
  // -------------------------------------------------------------------------

  /** Writes the portable storageState snapshot to disk. */
  private async saveSession(): Promise<void> {
    const state = await this.context.storageState();
    await fs.writeFile(this.paths.storageStatePath, JSON.stringify(state, null, 2), 'utf8');
  }
}
