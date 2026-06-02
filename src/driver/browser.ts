/**
 * BrowserManager — owns the single Playwright-controlled Chromium that drives
 * LinkedIn.
 *
 * This is NOT an Electron BrowserWindow. It is a real Chromium child process
 * launched via `chromium.launchPersistentContext()`, which gives us the full
 * Playwright API (locators, auto-waiting, network interception, storageState)
 * and a persistent on-disk profile under
 * `app.getPath('userData')/playwright-profile`.
 *
 * Because LinkedIn is single-session and flags parallel tabs / rapid bursts,
 * there is exactly one BrowserManager, one persistent context, and a small page
 * pool with a designated PRIMARY page that all navigation defaults to.
 *
 * Session strategy (two layers):
 *   - Primary:  the persistent profile keeps cookies/localStorage/IndexedDB on
 *               disk between runs, so a logged-in session survives restarts.
 *   - Secondary: on close we additionally export `storageState` to
 *               `userData/linkedin-session.json` (via SessionManager) for fast,
 *               browser-free validation and corruption recovery. On launch, if
 *               that artifact exists we re-inject its cookies as a belt-and-
 *               braces restore on top of the persistent profile.
 *
 * Events (EventEmitter):
 *   - 'launched'      (context: BrowserContext)
 *   - 'closed'        ()
 *   - 'page-created'  (page: Page)
 *
 * Strict TypeScript, defensive error handling, idempotent launch/close.
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

/** The options object accepted by `chromium.launchPersistentContext`. */
type PersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

import { getSessionManager, SessionManager } from './session';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Sub-directory (under userData) that holds the persistent Chromium profile. */
const PROFILE_DIR_NAME = 'playwright-profile';

/**
 * A recent, real Chrome user-agent. Pinning a believable UA (rather than the
 * Playwright/HeadlessChrome default) is part of reducing the automation
 * fingerprint. Bump this periodically to track shipping Chrome.
 */
const PINNED_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Init script that strips the `navigator.webdriver` tell. */
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
`;

/** Tunable launch knobs. The defaults match the project's brief. */
export interface BrowserManagerOptions {
  /** Run with a visible window. Default false per the local-app brief (user sees activity). */
  headless?: boolean;
  /** Slow each Playwright op by N ms — makes activity observable + slightly more human. */
  slowMo?: number;
  /** Viewport size. Default 1280x800. */
  viewport?: { width: number; height: number };
  /** Override the userData root (mainly for tests). Defaults to Electron app userData. */
  userDataDir?: string;
  /** Locale forwarded to Chromium. */
  locale?: string;
  /** Injected SessionManager (defaults to the shared singleton). */
  sessionManager?: SessionManager;
}

/** Strongly-typed event map for consumers that want type-checked listeners. */
export interface BrowserManagerEvents {
  launched: [context: BrowserContext];
  closed: [];
  'page-created': [page: Page];
}

// ---------------------------------------------------------------------------
// Electron userData resolution (lazy + defensive)
// ---------------------------------------------------------------------------

function resolveUserDataDir(): string {
  try {
    // Lazy require so this module loads outside Electron (tests / scripts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as typeof import('electron');
    if (electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    // Not in Electron — fall through.
  }
  return (
    process.env.LINKEDIN_MCP_USERDATA ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.linkedin-mcp')
  );
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

export class BrowserManager extends EventEmitter {
  private readonly headless: boolean;
  private readonly slowMo: number;
  private readonly viewport: { width: number; height: number };
  private readonly locale: string;
  private readonly userDataDir: string;
  private readonly profileDir: string;
  private readonly session: SessionManager;

  /** The live persistent context, or null when not launched. */
  private context: BrowserContext | null = null;

  /** The designated primary page within the pool. */
  private primaryPage: Page | null = null;

  /**
   * Guards against concurrent `launch()` calls racing to spawn two Chromiums.
   * The first caller creates the promise; everyone else awaits it.
   */
  private launching: Promise<BrowserContext> | null = null;

  constructor(options: BrowserManagerOptions = {}) {
    super();
    this.headless = options.headless ?? false;
    this.slowMo = options.slowMo ?? 50;
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.locale = options.locale ?? 'en-US';
    this.userDataDir = options.userDataDir ?? resolveUserDataDir();
    this.profileDir = join(this.userDataDir, PROFILE_DIR_NAME);
    this.session = options.sessionManager ?? getSessionManager();
  }

  // -- Lifecycle ----------------------------------------------------------

  /** True when a persistent context is currently live. */
  public isLaunched(): boolean {
    return this.context !== null;
  }

  /**
   * Launch (or return the already-live) persistent Chromium context.
   *
   * Idempotent: repeated calls return the same context. Concurrent calls share
   * a single in-flight launch. On first launch we optionally re-inject cookies
   * from the persisted storageState artifact as a recovery belt over the
   * persistent profile.
   */
  public async launch(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }
    if (this.launching) {
      return this.launching;
    }

    this.launching = this.doLaunch();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async doLaunch(): Promise<BrowserContext> {
    const contextOptions: PersistentContextOptions = {
      headless: this.headless,
      slowMo: this.slowMo,
      channel: 'chromium',
      viewport: this.viewport,
      locale: this.locale,
      userAgent: PINNED_USER_AGENT,
      ignoreHTTPSErrors: false,
      // Reduce the automation fingerprint Chromium advertises.
      args: ['--disable-blink-features=AutomationControlled'],
    };

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.profileDir, contextOptions);
    } catch (err) {
      throw new Error(
        `Failed to launch persistent Chromium at ${this.profileDir}: ${(err as Error).message}`,
      );
    }

    // Strip navigator.webdriver before any page script runs.
    try {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    } catch (err) {
      // Non-fatal: log to stderr (never stdout — MCP mode owns it) and continue.
      process.stderr.write(
        `[browser] addInitScript failed (non-fatal): ${(err as Error).message}\n`,
      );
    }

    // Recovery layer: if a persisted storageState exists, re-inject its cookies
    // on top of the persistent profile. The profile is authoritative, but this
    // guards against a profile that lost cookies while the artifact still holds
    // a valid session.
    await this.restoreCookies(context);

    this.context = context;

    // Persistent contexts always come up with one initial page; adopt it as the
    // primary, otherwise open one.
    const existing = context.pages();
    this.primaryPage = existing[0] ?? (await context.newPage());
    this.wirePage(this.primaryPage);

    // Track pages opened by LinkedIn (popups, etc.) so 'page-created' fires for them.
    context.on('page', (page) => {
      this.wirePage(page);
      this.emit('page-created', page);
    });

    // If the underlying browser dies (crash / external close), reset our state.
    context.on('close', () => {
      if (this.context === context) {
        this.context = null;
        this.primaryPage = null;
        this.emit('closed');
      }
    });

    this.emit('launched', context);
    return context;
  }

  /**
   * Close the context, persisting storageState first.
   *
   * Idempotent: safe to call when already closed. We snapshot the session
   * BEFORE closing so the portable artifact reflects the final cookie state.
   */
  public async close(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    // Persist storageState before teardown. Failure here must not block close.
    try {
      await this.session.save(context);
    } catch (err) {
      process.stderr.write(
        `[browser] failed to persist storageState on close: ${(err as Error).message}\n`,
      );
    }

    // Clearing references first prevents the 'close' handler from double-emitting.
    this.context = null;
    this.primaryPage = null;

    try {
      await context.close();
    } catch (err) {
      process.stderr.write(`[browser] error closing context: ${(err as Error).message}\n`);
    }

    this.emit('closed');
  }

  // -- Accessors ----------------------------------------------------------

  /**
   * Get the live context, launching lazily if necessary. Use this from action
   * code that must operate on a guaranteed-live context.
   */
  public async getContext(): Promise<BrowserContext> {
    return this.context ?? this.launch();
  }

  /**
   * Get the primary page, launching the browser lazily if necessary. If the
   * primary page was closed out from under us, a fresh one is created and
   * promoted to primary.
   */
  public async getPage(): Promise<Page> {
    const context = await this.getContext();
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      this.primaryPage = context.pages()[0] ?? (await context.newPage());
      this.wirePage(this.primaryPage);
    }
    return this.primaryPage;
  }

  /**
   * Open an additional page in the pool (e.g. for a parallel-read scrape that
   * still serializes through the action queue). Emits 'page-created'.
   *
   * Note: the 'page' context listener also fires 'page-created'; to avoid a
   * double emit we create the page here and rely solely on that listener, so
   * this method does not emit again itself.
   */
  public async newPage(): Promise<Page> {
    const context = await this.getContext();
    const page = await context.newPage();
    // `wirePage` + 'page-created' are handled by the context 'page' listener.
    return page;
  }

  // -- Internals ----------------------------------------------------------

  /** Re-inject persisted cookies into a freshly launched context, if any. */
  private async restoreCookies(context: BrowserContext): Promise<void> {
    try {
      const cookies = await this.session.getCookies();
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    } catch (err) {
      // The persistent profile remains the primary source of truth; restore is
      // best-effort recovery only.
      process.stderr.write(
        `[browser] cookie restore skipped (non-fatal): ${(err as Error).message}\n`,
      );
    }
  }

  /** Attach default timeouts / hardening to a page. Safe to call repeatedly. */
  private wirePage(page: Page): void {
    // Generous defaults; individual actions tighten these where appropriate.
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);
  }

  // -- Typed EventEmitter overrides --------------------------------------
  // Narrow the inherited signatures so listeners get correct argument types.

  public override on<E extends keyof BrowserManagerEvents>(
    event: E,
    listener: (...args: BrowserManagerEvents[E]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  public override once<E extends keyof BrowserManagerEvents>(
    event: E,
    listener: (...args: BrowserManagerEvents[E]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  public override emit<E extends keyof BrowserManagerEvents>(
    event: E,
    ...args: BrowserManagerEvents[E]
  ): boolean {
    return super.emit(event, ...args);
  }
}

/** Process-wide singleton, mirroring the single-session driver model. */
let singleton: BrowserManager | null = null;

/** Get (or lazily create) the shared BrowserManager. */
export function getBrowserManager(options?: BrowserManagerOptions): BrowserManager {
  if (!singleton) {
    singleton = new BrowserManager(options);
  }
  return singleton;
}
