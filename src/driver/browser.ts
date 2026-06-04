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

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/** Chromium singleton lock files written into a persistent profile directory. */
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** Small async sleep used while polling for the in-app page target. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspect a profile's `SingletonLock` (a `<host>-<pid>` symlink Chromium writes)
 * to decide whether a LIVE process still owns the profile. Returns `{alive,pid}`.
 * If the lock is missing/unreadable or the pid can't be parsed, it is treated as
 * NOT alive (stale) so recovery can proceed. Pid reuse is possible but rare; the
 * conservative failure is to report "alive" and surface a clear error rather than
 * corrupt a profile in genuine concurrent use.
 */
function inspectProfileLock(profileDir: string): { alive: boolean; pid: number | null } {
  try {
    const lockPath = join(profileDir, 'SingletonLock');
    if (!existsSync(lockPath)) return { alive: false, pid: null };
    const target = readlinkSync(lockPath); // e.g. "MyHost-12345"
    const pid = Number.parseInt(target.slice(target.lastIndexOf('-') + 1), 10);
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid: null };
    try {
      process.kill(pid, 0); // throws ESRCH if the process is gone
      return { alive: true, pid };
    } catch (e) {
      // EPERM = process exists but owned by another user (still alive); else dead.
      return { alive: (e as NodeJS.ErrnoException).code === 'EPERM', pid };
    }
  } catch {
    return { alive: false, pid: null };
  }
}

/** Remove Chromium singleton lock files so a fresh launch can claim the profile. */
function clearProfileLocks(profileDir: string): void {
  for (const name of SINGLETON_FILES) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      /* best effort — a missing/locked file must never block recovery */
    }
  }
}

/**
 * Whether `pid` is a Chromium/Chrome-for-Testing process. Used before killing a
 * lock owner: the profile dir is dedicated to this driver, so a Chromium holding
 * it is our own orphan and safe to terminate — but we must never kill an
 * unrelated process that happens to have reused the pid.
 */
function isChromiumProcess(pid: number): boolean {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /chrom(e|ium)|Chrome for Testing/i.test(out);
  } catch {
    return false; // ps failed / no such process — treat as not-ours, don't kill.
  }
}

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

/**
 * How the manager obtains its Chromium:
 *   - 'launch'  — spawn a dedicated Playwright Chromium via
 *                 `launchPersistentContext` (the MCP / npx / headless path).
 *   - 'connect' — attach over CDP to a Chromium we did NOT launch (the Electron
 *                 in-app `BrowserView`). There is exactly one page (the view);
 *                 the browser's lifecycle is owned by Electron, not by us, so we
 *                 must never close it.
 */
export type BrowserMode = 'launch' | 'connect';

/** Hosts considered "LinkedIn" when locating the in-app page in connect mode. */
const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;

/** Tunable launch knobs. The defaults match the project's brief. */
export interface BrowserManagerOptions {
  /** Acquisition strategy. Default 'launch'. */
  mode?: BrowserMode;
  /**
   * CDP endpoint to attach to in 'connect' mode, e.g. `http://127.0.0.1:47872`.
   * Ignored in 'launch' mode; required in 'connect' mode.
   */
  cdpEndpoint?: string;
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

/**
 * Point Playwright at the Chromium we bundle into the app.
 *
 * `electron-builder` copies `node_modules/playwright-core/.local-browsers` to
 * `Resources/playwright-browsers` (see electron-builder.json `extraResources`).
 * A packaged app cannot reach the developer's `~/…/ms-playwright` cache, so we
 * set `PLAYWRIGHT_BROWSERS_PATH` to the bundled copy BEFORE the first launch —
 * Playwright reads this env var when it resolves the executable. Runs once and
 * only inside a packaged Electron build; the npx/dev paths keep using the cache
 * the postinstall populated, and any pre-set env var wins.
 */
let bundledBrowsersResolved = false;
function useBundledBrowsersIfPackaged(): void {
  if (bundledBrowsersResolved) return;
  bundledBrowsersResolved = true;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return; // explicit override wins
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const electron = require('electron') as typeof import('electron');
    if (!electron.app?.isPackaged) return;
    const bundled = join(process.resourcesPath, 'playwright-browsers');
    if (existsSync(bundled)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
    } else {
      process.stderr.write(
        `[browser] packaged app but bundled browsers missing at ${bundled}; ` +
          `falling back to the default Playwright cache.\n`,
      );
    }
  } catch {
    // Not in Electron — nothing to resolve.
  }
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

export class BrowserManager extends EventEmitter {
  private readonly mode: BrowserMode;
  private readonly cdpEndpoint: string | undefined;
  private readonly headless: boolean;
  private readonly slowMo: number;
  private readonly viewport: { width: number; height: number };
  private readonly locale: string;
  private readonly userDataDir: string;
  private readonly profileDir: string;
  private readonly session: SessionManager;

  /**
   * The CDP-attached Browser handle in 'connect' mode. We keep it across
   * `close()`/`launch()` cycles and reuse it rather than re-attaching, since the
   * underlying Chromium (Electron's) outlives our driver. Null in 'launch' mode
   * and before the first connect.
   */
  private cdpBrowser: Browser | null = null;

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
    this.mode = options.mode ?? 'launch';
    this.cdpEndpoint = options.cdpEndpoint;
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

  /**
   * Launch the persistent context, recovering from a STALE Chromium profile
   * lock. Chromium writes a `SingletonLock` symlink (`<host>-<pid>`) into the
   * profile; if a prior run was killed uncleanly — e.g. the MCP host (Claude
   * Desktop) SIGKILLed the server on quit/restart, leaving the browser orphaned
   * — the lock survives and the next launch fails with "Opening in existing
   * browser session". MCP clients respawn servers routinely, so this is common.
   * We detect a dead lock owner, remove the singleton files, and retry once. If
   * the owner is genuinely ALIVE, another instance holds the profile and we
   * surface an actionable error instead of corrupting it.
   */
  private async launchWithLockRecovery(
    contextOptions: PersistentContextOptions,
  ): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(this.profileDir, contextOptions);
    } catch (err) {
      const message = (err as Error).message ?? '';
      const isLockError =
        /already in use|existing browser session|ProcessSingleton|SingletonLock|profile.*in use/i.test(
          message,
        );
      if (!isLockError) throw err;

      const owner = inspectProfileLock(this.profileDir);
      if (owner.alive && owner.pid !== null) {
        if (isChromiumProcess(owner.pid)) {
          // Orphaned browser from a previous run: the MCP host (e.g. Claude
          // Desktop) SIGKILLed our server but the Chromium child survived and
          // still holds OUR dedicated profile. Terminate it and reclaim.
          try {
            process.kill(owner.pid, 'SIGKILL');
          } catch {
            /* already gone between inspect and kill */
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          // A live, non-Chromium process owns the lock (pid reuse). Don't kill
          // an unrelated process — surface an actionable error instead.
          throw new Error(
            `the profile lock is held by pid ${owner.pid}, which is not our Chromium. ` +
              `Set a different LINKEDIN_MCP_USERDATA, or clear the lock manually.`,
          );
        }
      }

      // Owner was dead (stale lock) or an orphan we just killed: clear the
      // singleton files and retry once.
      clearProfileLocks(this.profileDir);
      process.stderr.write(
        '[browser] recovered a held/stale Chromium profile lock; retrying launch.\n',
      );
      return await chromium.launchPersistentContext(this.profileDir, contextOptions);
    }
  }

  private async doLaunch(): Promise<BrowserContext> {
    if (this.mode === 'connect') {
      return this.doConnect();
    }

    // Resolve the bundled Chromium location before Playwright reads it.
    useBundledBrowsersIfPackaged();

    // Reduce the automation fingerprint Chromium advertises.
    const args = ['--disable-blink-features=AutomationControlled'];

    // When running HEADED (the default for the embedded-mirror app), push the
    // real Chromium window far off-screen so the user only ever sees it mirrored
    // in the app pane — yet it stays a genuine headed browser, which third-party
    // identity providers (e.g. Google sign-in) accept where they reject
    // headless. The anti-throttle flags stop Chromium from pausing rendering of
    // an off-screen/occluded window, which would otherwise freeze the screencast.
    if (!this.headless) {
      args.push(
        '--window-position=-10000,-10000',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion',
      );
    }

    const contextOptions: PersistentContextOptions = {
      headless: this.headless,
      slowMo: this.slowMo,
      channel: 'chromium',
      viewport: this.viewport,
      locale: this.locale,
      userAgent: PINNED_USER_AGENT,
      ignoreHTTPSErrors: false,
      args,
    };

    let context: BrowserContext;
    try {
      context = await this.launchWithLockRecovery(contextOptions);
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

  // -- Connect mode (attach to Electron's in-app BrowserView over CDP) -------

  /**
   * Attach over CDP to the Chromium that Electron already runs (the in-app
   * `BrowserView`) instead of launching our own. The action modules then drive
   * the SAME page the user sees natively — no screencast.
   *
   * The connection is reused across `close()`/`launch()` cycles: Electron owns
   * the browser's lifecycle, so we attach once and re-point at its single page.
   * We NEVER call `cdpBrowser.close()` — that would tear down the user's app.
   */
  private async doConnect(): Promise<BrowserContext> {
    if (!this.cdpEndpoint) {
      throw new Error('BrowserManager: connect mode requires a cdpEndpoint');
    }

    // Reuse a still-live attachment; only (re)connect when we have none.
    if (!this.cdpBrowser || !this.cdpBrowser.isConnected()) {
      this.cdpBrowser = await chromium.connectOverCDP(this.cdpEndpoint);
      this.cdpBrowser.on('disconnected', () => {
        // Electron's Chromium went away (app quitting / view destroyed).
        this.cdpBrowser = null;
        if (this.context) {
          this.context = null;
          this.primaryPage = null;
          this.emit('closed');
        }
      });
    }

    // connectOverCDP always surfaces a single default browser context that holds
    // every page target (the renderer window AND the LinkedIn view).
    const context = this.cdpBrowser.contexts()[0];
    if (!context) {
      throw new Error('BrowserManager: connected browser exposed no context');
    }

    // Stealth: applies to FUTURE navigations of the connected page (the already
    // loaded document is unaffected, but that document was loaded by a genuine
    // headed Electron Chromium with no automation switch, so navigator.webdriver
    // is already absent — this just keeps it so as the user/agent navigates).
    try {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    } catch (err) {
      process.stderr.write(
        `[browser] addInitScript (connect) failed (non-fatal): ${(err as Error).message}\n`,
      );
    }

    const page = await this.findLinkedInPage(context);
    this.context = context;
    this.primaryPage = page;
    this.wirePage(page);

    this.emit('launched', context);
    return context;
  }

  /**
   * Locate the in-app LinkedIn page among the connected context's targets,
   * skipping the control-panel renderer (a `file://`/`data:` page). The
   * `BrowserView` is navigated to LinkedIn before we connect, but a load may be
   * in flight, so we poll briefly.
   */
  private async findLinkedInPage(context: BrowserContext): Promise<Page> {
    const host = (p: Page): string => {
      try {
        return new URL(p.url()).host;
      } catch {
        return '';
      }
    };

    for (let attempt = 0; attempt < 50; attempt++) {
      const linkedin = context.pages().find((p) => LINKEDIN_HOST_RE.test(host(p)));
      if (linkedin) return linkedin;
      await delay(100);
    }

    // Fallback: the first page that isn't the renderer chrome. Covers the case
    // where the view briefly sits on about:blank or a non-LinkedIn URL the user
    // typed; once grabbed, the Page handle survives later navigations.
    const fallback = context.pages().find((p) => {
      const url = p.url();
      return !!url && !/^(file|data|devtools|chrome):/i.test(url) && url !== 'about:blank';
    });
    if (fallback) return fallback;

    throw new Error(
      'BrowserManager: could not locate the in-app LinkedIn page over CDP (is the BrowserView attached?)',
    );
  }

  /**
   * Close the context, persisting storageState first.
   *
   * Idempotent: safe to call when already closed. We snapshot the session
   * BEFORE closing so the portable artifact reflects the final cookie state.
   *
   * In CONNECT mode we never tear down Electron's Chromium — we only drop our
   * references (and keep the CDP attachment for reuse), so "stop"/"restart" from
   * the UI re-points the driver without killing the window the user is looking at.
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

    if (this.mode === 'connect') {
      // Leave Electron's browser + our CDP attachment alone; just signal closed.
      this.emit('closed');
      return;
    }

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

    // Connect mode: there is exactly ONE page — the in-app BrowserView. Never
    // open a tab (it would be an invisible, un-mirrored page). If our handle
    // went stale (view destroyed/recreated), re-locate the LinkedIn target.
    if (this.mode === 'connect') {
      if (!this.primaryPage || this.primaryPage.isClosed()) {
        this.primaryPage = await this.findLinkedInPage(context);
        this.wirePage(this.primaryPage);
      }
      return this.primaryPage;
    }

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
   *
   * In CONNECT mode there is no page pool — the single in-app view IS the page,
   * so this returns it rather than spawning an unmirrored tab.
   */
  public async newPage(): Promise<Page> {
    if (this.mode === 'connect') {
      return this.getPage();
    }
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
