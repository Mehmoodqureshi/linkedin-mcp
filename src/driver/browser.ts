/**
 * BrowserManager — owns the single Playwright-controlled Chromium that drives
 * LinkedIn.
 *
 * The driver is CONNECT-ONLY: it never launches its own Chromium. It attaches
 * over CDP (`chromium.connectOverCDP`) to a Chromium we did NOT start — the
 * desktop app's in-app Electron `BrowserView`. The action modules then drive the
 * SAME page the user sees natively (no screencast, no headless browser). The
 * browser's lifecycle is owned by Electron, so we attach and re-point at its
 * single page but NEVER close it.
 *
 * Because LinkedIn is single-session and flags parallel tabs / rapid bursts,
 * there is exactly one BrowserManager and one designated PRIMARY page (the
 * in-app view) that all navigation defaults to.
 *
 * Session strategy:
 *   - The Electron `BrowserView` uses a persistent session partition, so the
 *     logged-in LinkedIn session lives on disk and survives app restarts.
 *   - On close we export `storageState` to `userData/linkedin-session.json` (via
 *     SessionManager) for fast, browser-free validation and debugging.
 *
 * Events (EventEmitter):
 *   - 'launched'      (context: BrowserContext)   — kept for API compatibility;
 *                      fires when we have (re)attached and located the page.
 *   - 'closed'        ()
 *   - 'page-created'  (page: Page)
 *
 * Strict TypeScript, defensive error handling, idempotent attach/close.
 */

import { EventEmitter } from 'node:events';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/** Small async sleep used while polling for the in-app page target. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { getSessionManager, SessionManager } from './session';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Init script that strips the `navigator.webdriver` tell. */
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
`;

/** Hosts considered "LinkedIn" when locating the in-app page. */
const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;

/** Tunable knobs for the CDP attachment. */
export interface BrowserManagerOptions {
  /**
   * CDP endpoint to attach to, e.g. `http://127.0.0.1:47872`. When omitted, the
   * manager falls back to `resolveEndpoint` at attach time (which may discover a
   * running app and/or launch one). If neither yields an endpoint, connecting
   * fails with an actionable error.
   */
  cdpEndpoint?: string;
  /**
   * Lazy resolver invoked at attach time when no explicit `cdpEndpoint` is set.
   * Returns an endpoint (e.g. by discovering / launching the desktop app) or
   * null when none is available. Kept lazy so a server that starts before the
   * app can still attach once the app comes up, and so app-launch only happens
   * on first real use.
   */
  resolveEndpoint?: () => Promise<string | null>;
  /** Slow each Playwright op by N ms — makes activity observable + slightly more human. */
  slowMo?: number;
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
// BrowserManager
// ---------------------------------------------------------------------------

export class BrowserManager extends EventEmitter {
  private cdpEndpoint: string | undefined;
  private readonly resolveEndpoint: (() => Promise<string | null>) | undefined;
  private readonly slowMo: number;
  private readonly session: SessionManager;

  /**
   * The CDP-attached Browser handle. We keep it across `close()`/`launch()`
   * cycles and reuse it rather than re-attaching, since the underlying Chromium
   * (Electron's) outlives our driver. Null before the first connect.
   */
  private cdpBrowser: Browser | null = null;

  /** The live browser context, or null when not attached. */
  private context: BrowserContext | null = null;

  /** The designated primary page (the in-app view). */
  private primaryPage: Page | null = null;

  /**
   * Guards against concurrent `launch()` calls racing to attach twice. The first
   * caller creates the promise; everyone else awaits it.
   */
  private launching: Promise<BrowserContext> | null = null;

  constructor(options: BrowserManagerOptions = {}) {
    super();
    this.cdpEndpoint = options.cdpEndpoint;
    this.resolveEndpoint = options.resolveEndpoint;
    this.slowMo = options.slowMo ?? 50;
    this.session = options.sessionManager ?? getSessionManager();
  }

  // -- Lifecycle ----------------------------------------------------------

  /** True when a context is currently attached. */
  public isLaunched(): boolean {
    return this.context !== null;
  }

  /**
   * Attach to (or return the already-attached) Chromium context over CDP.
   *
   * Idempotent: repeated calls return the same context. Concurrent calls share a
   * single in-flight attach. Named `launch()` for compatibility with callers,
   * but it never spawns a browser — it connects to the running app's.
   */
  public async launch(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }
    if (this.launching) {
      return this.launching;
    }

    this.launching = this.doConnect();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  // -- Connect (attach to the app's in-app BrowserView over CDP) -----------

  /**
   * Attach over CDP to the Chromium that the desktop app already runs (the
   * in-app `BrowserView`). The action modules then drive the SAME page the user
   * sees natively — no screencast.
   *
   * The connection is reused across `close()`/`launch()` cycles: Electron owns
   * the browser's lifecycle, so we attach once and re-point at its single page.
   * We NEVER call `cdpBrowser.close()` — that would tear down the user's app.
   */
  private async doConnect(): Promise<BrowserContext> {
    // Resolve an endpoint lazily: an explicit one wins; otherwise ask the
    // resolver (which may discover a running app or launch one). Done here, not
    // in the constructor, so a server that starts before the app can still
    // attach once the app is up, and app-launch happens only on first real use.
    if (!this.cdpEndpoint && this.resolveEndpoint) {
      this.cdpEndpoint = (await this.resolveEndpoint()) ?? undefined;
    }
    if (!this.cdpEndpoint) {
      throw new Error(
        'No running LinkedIn app found to attach to. This driver attaches to the ' +
          'desktop app over CDP and never launches its own browser — start the ' +
          'LinkedIn app first (or set LINKEDIN_CDP_ENDPOINT to a reachable endpoint).',
      );
    }

    // Reuse a still-live attachment; only (re)connect when we have none.
    if (!this.cdpBrowser || !this.cdpBrowser.isConnected()) {
      try {
        this.cdpBrowser = await chromium.connectOverCDP(this.cdpEndpoint, { slowMo: this.slowMo });
      } catch (err) {
        this.cdpBrowser = null;
        const failedEndpoint = this.cdpEndpoint;
        // If this endpoint came from the resolver (not an explicit env value),
        // drop it so the next attempt re-discovers / re-launches rather than
        // retrying a dead port from a since-closed app.
        if (this.resolveEndpoint && !process.env.LINKEDIN_CDP_ENDPOINT) {
          this.cdpEndpoint = undefined;
        }
        throw new Error(
          `Failed to attach to the LinkedIn app at ${failedEndpoint}: ${(err as Error).message}. ` +
            `Is the app running?`,
        );
      }
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
   * Close: drop our references, persisting storageState first. We NEVER tear down
   * Electron's Chromium — we keep the CDP attachment for reuse, so "stop"/"restart"
   * from the UI re-points the driver without killing the window the user sees.
   *
   * Idempotent: safe to call when already closed.
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

    // Clearing references first prevents the 'disconnected' handler from double-emitting.
    this.context = null;
    this.primaryPage = null;

    // Leave Electron's browser + our CDP attachment alone; just signal closed.
    this.emit('closed');
  }

  // -- Accessors ----------------------------------------------------------

  /**
   * Get the live context, attaching lazily if necessary. Use this from action
   * code that must operate on a guaranteed-live context.
   */
  public async getContext(): Promise<BrowserContext> {
    return this.context ?? this.launch();
  }

  /**
   * Get the primary page, attaching lazily if necessary. There is exactly ONE
   * page — the in-app BrowserView. Never open a tab (it would be an invisible,
   * un-mirrored page). If our handle went stale (view destroyed/recreated),
   * re-locate the LinkedIn target.
   */
  public async getPage(): Promise<Page> {
    const context = await this.getContext();

    if (!this.primaryPage || this.primaryPage.isClosed()) {
      this.primaryPage = await this.findLinkedInPage(context);
      this.wirePage(this.primaryPage);
    }
    return this.primaryPage;
  }

  /**
   * There is no page pool: the single in-app view IS the page, so this returns
   * it rather than spawning an unmirrored tab. Kept for API compatibility with
   * callers that expect a `newPage()`.
   */
  public async newPage(): Promise<Page> {
    return this.getPage();
  }

  // -- Internals ----------------------------------------------------------

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
