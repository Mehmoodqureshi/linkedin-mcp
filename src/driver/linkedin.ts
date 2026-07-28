/**
 * LinkedInDriver — the main orchestrator / facade for the automation layer.
 *
 * This class composes the low-level pieces (browser, session) with the
 * high-level action modules (auth, profile, search, messaging, connections,
 * feed) behind a single, stable surface. The rest of the app (IPC handlers,
 * MCP tools) only ever talks to a `LinkedInDriver` instance — never directly
 * to Playwright or to an individual action class.
 *
 * Design notes:
 *   - Configuration is read from `process.env` in the constructor; the driver
 *     takes no arguments so it can be instantiated as a process-wide singleton.
 *   - All action classes share a single Playwright `Page` (the "primary page").
 *     They are constructed against that page; if it ever dies, `getPage()`
 *     transparently re-creates it so the driver survives a crashed tab without
 *     a full relaunch.
 *   - The browser is launched lazily by `launch()`; nothing touches Chromium
 *     until then, keeping process startup (especially MCP mode) fast.
 */

import { BrowserManager } from './browser';
import { SessionManager, getSessionManager } from './session';
import { AuthActions } from './actions/auth';
import { ProfileActions } from './actions/profile';
import { ProfileEditActions } from './actions/profile-edit';
import { SearchActions } from './actions/search';
import { MessagingActions } from './actions/messages';
import { ConnectionActions } from './actions/connections';
import { FeedActions } from './actions/feed';

import type { Page } from 'playwright-core';
import type { DriverState, DriverStatus } from './types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolved configuration sourced from `process.env`. */
interface DriverConfig {
  /**
   * How the browser is obtained. 'connect' (set by the Electron UI) attaches
   * over CDP to the in-app BrowserView; 'launch' (MCP / npx / default) spawns a
   * dedicated Playwright Chromium.
   */
  browserMode: 'launch' | 'connect';
  /** CDP endpoint to attach to in connect mode (e.g. http://127.0.0.1:47872). */
  cdpEndpoint: string | undefined;
  /** Run Chromium headless. Defaults to false (real LinkedIn flags headless). */
  headless: boolean;
  /** Per-operation Playwright delay (ms). 0 for snappy interactive mirroring. */
  slowMo: number;
  /** LinkedIn account email, if provided via env for auto-login. */
  email: string | undefined;
  /** LinkedIn account password, if provided via env for auto-login. */
  password: string | undefined;
  /** Absolute path to the persistent Chromium profile directory. */
  userDataDir: string | undefined;
  /** Drive the user's REAL Chrome profile of this name (e.g. "Default") instead of a dedicated one. */
  chromeProfile: string | undefined;
  /** Chrome user-data-dir holding `chromeProfile` (defaults to the OS Chrome dir). */
  chromeUserDataDir: string | undefined;
}

function readConfig(): DriverConfig {
  const truthy = (v: string | undefined): boolean =>
    v === '1' || v?.toLowerCase() === 'true';

  const rawSlowMo = Number(process.env.LINKEDIN_SLOWMO);
  const slowMo = Number.isFinite(rawSlowMo) && rawSlowMo >= 0 ? rawSlowMo : 50;

  const cdpEndpoint = process.env.LINKEDIN_CDP_ENDPOINT;
  // Connect mode only when explicitly requested AND we have somewhere to attach.
  const browserMode =
    process.env.LINKEDIN_BROWSER_MODE === 'connect' && cdpEndpoint ? 'connect' : 'launch';

  return {
    browserMode,
    cdpEndpoint,
    headless: truthy(process.env.LINKEDIN_HEADLESS),
    slowMo,
    email: process.env.LINKEDIN_EMAIL,
    password: process.env.LINKEDIN_PASSWORD,
    userDataDir: process.env.LINKEDIN_USER_DATA_DIR,
    chromeProfile: process.env.LINKEDIN_CHROME_PROFILE,
    chromeUserDataDir: process.env.LINKEDIN_CHROME_USER_DATA_DIR,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class LinkedInDriver {
  /** Owns the Playwright browser/context lifecycle. */
  public readonly browser: BrowserManager;

  /** Persists, restores and validates the LinkedIn session artifact. */
  public readonly session: SessionManager;

  // Action modules. These are assigned during `launch()`, once a Page exists.
  // The definite-assignment assertion is intentional: every accessor is
  // unusable (guarded by `ensureReady`) until `launch()` has wired them up.
  public auth!: AuthActions;
  public profile!: ProfileActions;
  public profileEdit!: ProfileEditActions;
  public search!: SearchActions;
  public messages!: MessagingActions;
  public connections!: ConnectionActions;
  public feed!: FeedActions;

  /** Current lifecycle state. */
  public status: DriverState = 'idle';

  private readonly config: DriverConfig;

  /** The shared primary page handed to every action class. */
  private page: Page | null = null;

  /** Cached login flag, refreshed on `launch()` and auth transitions. */
  private loggedIn = false;

  /** Last cheap session-validity snapshot (no Chromium required to read). */
  private sessionValid = false;

  constructor() {
    this.config = readConfig();
    this.browser = new BrowserManager({
      mode: this.config.browserMode,
      ...(this.config.cdpEndpoint !== undefined
        ? { cdpEndpoint: this.config.cdpEndpoint }
        : {}),
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      ...(this.config.userDataDir !== undefined
        ? { userDataDir: this.config.userDataDir }
        : {}),
      ...(this.config.chromeProfile !== undefined
        ? { chromeProfile: this.config.chromeProfile }
        : {}),
      ...(this.config.chromeUserDataDir !== undefined
        ? { chromeUserDataDir: this.config.chromeUserDataDir }
        : {}),
    });
    // Shared process-wide session manager (single-session model).
    this.session = getSessionManager();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Launch the browser, create the primary page, wire up every action module,
   * and attempt to restore a previously persisted session.
   *
   * Idempotent: a `launch()` on an already-ready (or in-flight) driver is a
   * no-op.
   */
  async launch(): Promise<void> {
    if (this.status === 'ready' || this.status === 'launching') return;

    this.status = 'launching';
    try {
      // 1. Bring up Chromium + a persistent browser context.
      await this.browser.launch();

      // 2. Create the single page every action module shares.
      this.page = await this.browser.newPage();

      // 3. Bind all action classes to that shared page.
      this.wireActions(this.page);

      // 4. If the browser dies out from under us (crash, the user closes the
      //    Chromium window, an OS kill), drop back to 'idle' so the NEXT call
      //    relaunches and re-wires the action modules against a fresh page.
      //    Without this the driver stays falsely 'ready' while every action
      //    module is pinned to a dead page, so every subsequent tool call fails
      //    with "Target page, context or browser has been closed" until the
      //    whole server is restarted.
      this.browser.once('closed', () => {
        if (this.status === 'ready') {
          this.status = 'idle';
          this.page = null;
          this.loggedIn = false;
        }
      });

      // 5. Best-effort session restore. A failure here is non-fatal: the user
      //    can still log in interactively, so we don't flip to 'error'.
      await this.refreshSession();

      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  /** (Re)bind every action module to the given primary page. */
  private wireActions(page: Page): void {
    this.auth = new AuthActions(page);
    this.profile = new ProfileActions(page);
    this.profileEdit = new ProfileEditActions(page);
    this.search = new SearchActions(page);
    this.messages = new MessagingActions(page);
    this.connections = new ConnectionActions(page);
    this.feed = new FeedActions(page);
  }

  /**
   * Make the driver operational right before an action runs. Two recovery paths:
   *
   *   1. The browser crashed / was closed → status is no longer 'ready' → a full
   *      `launch()` brings Chromium back and re-wires the action modules.
   *   2. The context is alive but the primary tab died → rebuild the page and
   *      re-wire the action modules so they never operate on a stale, closed
   *      page (the action classes capture the page by reference at construction,
   *      so a fresh page MUST be threaded back into them).
   *
   * Tool handlers call this so a mid-session disconnect self-heals on the next
   * request instead of wedging the server.
   */
  async ensureOperational(): Promise<void> {
    if (this.status !== 'ready') {
      await this.launch();
      return;
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.getPage();
      this.wireActions(this.page);
    }
  }

  /**
   * Persist the current session and tear the browser down.
   * Idempotent: safe to call when already closed.
   */
  async close(): Promise<void> {
    if (this.status === 'closed') return;

    try {
      // Save session before the context disappears (best-effort). Only touch
      // the context if the browser is actually launched, to avoid spinning one
      // up just to tear it down.
      if (this.browser.isLaunched()) {
        const context = await this.browser.getContext();
        await this.session.save(context);
      }
    } catch {
      // Saving is best-effort; never block shutdown on it.
    } finally {
      try {
        await this.browser.close();
      } finally {
        this.page = null;
        this.loggedIn = false;
        this.status = 'closed';
      }
    }
  }

  // -------------------------------------------------------------------------
  // Page access
  // -------------------------------------------------------------------------

  /**
   * Return the shared primary page, lazily (re)creating it if it was never
   * opened or has since been closed (e.g. a crashed tab). Action modules that
   * need a guaranteed-live page route through here.
   */
  async getPage(): Promise<Page> {
    this.ensureReady();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
    }
    return this.page;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Snapshot of the driver's health for IPC / MCP / tray consumers. */
  getStatus(): DriverStatus {
    return {
      status: this.status,
      isLoggedIn: this.loggedIn,
      sessionValid: this.sessionValid,
    };
  }

  /**
   * Re-evaluate session validity (cheap, browser-free) and — when a context is
   * live and a valid session artifact exists — confirm we are actually logged
   * in. Call after login/logout to keep `getStatus()` accurate.
   *
   * `navigate` (default true) is forwarded to the live login check. Pass false
   * from navigation-event callers so the check inspects the page where it sits
   * instead of forcing a /feed goto (which would loop the browser reloading).
   */
  async refreshSession(opts: { navigate?: boolean } = {}): Promise<void> {
    // Cheap, browser-free heuristic from the saved storageState artifact.
    try {
      this.sessionValid = await this.session.hasValidSession();
    } catch {
      this.sessionValid = false;
    }

    // Authoritative check: with a PERSISTENT Chromium profile the live login
    // state lives in the profile directory, NOT in linkedin-session.json. The
    // storageState artifact can lag behind the profile (e.g. it was saved before
    // an interactive login), so we must NOT gate the live check on sessionValid —
    // doing so made the driver report "not logged in" for a genuinely authed
    // profile, which in turn made the HITL login gate re-prompt every run.
    // Whenever the auth module is wired to a live page, trust the live check.
    if (this.auth) {
      try {
        this.loggedIn = await this.auth.isLoggedIn(opts);
      } catch {
        this.loggedIn = false;
      }
      // A confirmed live session is the strongest signal — don't let a stale
      // artifact under-report it.
      if (this.loggedIn) {
        this.sessionValid = true;
      }
    } else {
      this.loggedIn = false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureReady(): void {
    if (this.status !== 'ready') {
      throw new Error(
        `LinkedInDriver is not ready (status: ${this.status}); call launch() first`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: LinkedInDriver | null = null;

/**
 * Return the process-wide `LinkedInDriver` singleton, creating it on first use.
 *
 * A single instance is intentional: two LinkedIn sessions racing each other
 * trips bot-detection, and the persisted profile directory is a shared,
 * exclusive resource.
 */
export function getInstance(): LinkedInDriver {
  if (!instance) {
    instance = new LinkedInDriver();
  }
  return instance;
}

/**
 * Dispose of the current singleton (closing the browser) and drop the
 * reference so the next `getInstance()` starts fresh. Primarily useful for
 * tests and clean shutdown.
 */
export async function resetInstance(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
