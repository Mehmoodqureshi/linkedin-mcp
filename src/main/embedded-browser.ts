/**
 * EmbeddedBrowser — hosts the LinkedIn browser NATIVELY inside the app.
 *
 * Unlike the old screencast mirror, there is no streaming and no input replay:
 * we dock a real Electron `BrowserView` into the renderer's right pane, and the
 * user scrolls/clicks/types it directly. The Playwright automation layer drives
 * the SAME web contents by attaching over CDP (see BrowserManager 'connect'
 * mode), so the agent's actions appear live in the very view the user sees.
 *
 * Responsibilities:
 *   - Create the `BrowserView` with a persistent session partition
 *     (`persist:linkedin`) so the login survives restarts, and a pinned Chrome
 *     user-agent so it doesn't advertise "Electron".
 *   - Dock it into the window and keep its bounds matched to the `#stage` pane
 *     the renderer measures (`browser:bounds`).
 *   - Drive the toolbar/nav-rail controls (`browser:navigate` / `:back` /
 *     `:forward` / `:reload` / `:login`) against the view's web contents.
 *   - Reflect navigation + load state back to the renderer's URL bar
 *     (`browser:url` / `browser:loading`).
 *   - Allow auth popups (e.g. Google "Continue with…") to open as real windows.
 *
 * The driver attaches over CDP AFTER the view exists and has navigated to
 * LinkedIn; `attach()` creates the view and then kicks the driver's lazy launch.
 */

import { app, BrowserView, BrowserWindow, ipcMain, net, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { LinkedInDriver } from '../driver/linkedin';

/** Persistent partition that stores the in-app LinkedIn cookies/localStorage. */
const SESSION_PARTITION = 'persist:linkedin';

/**
 * Where we remember the LAST signed-in member (name + avatar) so the connect
 * screen can offer a one-tap "Continue as …" tile after sign-out. This lives in
 * userData — NOT the session partition — so it deliberately SURVIVES logout
 * (which only wipes the partition). It holds no credentials, just a display
 * name and a self-contained avatar data URL.
 */
const lastAccountPath = (): string => join(app.getPath('userData'), 'last-account.json');

/** Remembered account shape persisted to {@link lastAccountPath}. */
interface LastAccount {
  name: string;
  avatarDataUrl?: string;
  capturedAt: number;
}

/** LinkedIn entry points. */
const FEED_URL = 'https://www.linkedin.com/feed/';
const LOGIN_URL = 'https://www.linkedin.com/login';

/**
 * Hosts whose popups we allow to open as real in-app windows — only identity
 * providers used by LinkedIn's "Continue with…" sign-in. Everything else is
 * routed to the user's system browser so a page can't spawn arbitrary in-app
 * windows (a stray ad/redirect won't get a foothold).
 */
const AUTH_POPUP_HOSTS = [
  /(^|\.)linkedin\.com$/i,
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
];

function isAuthPopupUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    return AUTH_POPUP_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/**
 * A recent, real Chrome UA — Electron's default UA leaks "Electron/<ver>", which
 * is a glaring automation tell. Keep this in step with the driver's pinned UA.
 */
const PINNED_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Pane rectangle (CSS px, relative to the window content) the view docks into. */
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class EmbeddedBrowser {
  private readonly getDriver: () => LinkedInDriver;

  /**
   * Only dock the native view when the driver is in CONNECT mode (UI launch).
   * In MCP mode the driver launches its own Chromium with no remote-debugging
   * port, so an in-app view would be decoupled from automation — better to keep
   * the tray window a pure control panel there.
   */
  private readonly enabled: boolean;

  /** The window the view is docked into. */
  private win: BrowserWindow | null = null;

  /** The docked LinkedIn view, or null before attach / after teardown. */
  private view: BrowserView | null = null;

  /** Last bounds reported by the renderer, re-applied when the view (re)appears. */
  private bounds: Bounds | null = null;

  /** Guards concurrent attach() calls. */
  private attaching: Promise<void> | null = null;

  /** Guards re-entrant auth re-checks fired from navigation events. */
  private authSyncing = false;

  /** Capture the signed-in member's name+avatar at most once per session. */
  private accountCaptured = false;

  constructor(getDriver: () => LinkedInDriver, enabled: boolean) {
    this.getDriver = getDriver;
    this.enabled = enabled;
  }

  /** Point the host at the renderer window. Call once after window creation. */
  public setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  /**
   * Register the IPC surface the renderer drives the embedded browser through.
   * Mirrors the old mirror channels so the preload allow-list is unchanged, but
   * the high-frequency screencast/input channels are gone.
   */
  public registerIpc(): void {
    ipcMain.handle('browser:attach', () => this.safe(() => this.attach()));
    ipcMain.handle('browser:detach', () => this.safe(() => this.detach()));
    ipcMain.handle('browser:navigate', (_e, url: unknown) =>
      this.safe(() => this.navigate(String(url ?? ''))),
    );
    ipcMain.handle('browser:back', () => this.safe(() => this.goBack()));
    ipcMain.handle('browser:forward', () => this.safe(() => this.goForward()));
    ipcMain.handle('browser:reload', () => this.safe(() => this.reload()));
    ipcMain.handle('browser:login', () => this.safe(() => this.navigate(LOGIN_URL)));
    ipcMain.handle('browser:bounds', (_e, b: unknown) =>
      this.safe(() => this.setBounds(b as Bounds)),
    );
    // Open LinkedIn's own login page in a dedicated window and report whether
    // the user ended up authenticated. Returns the richer { authenticated }
    // shape, so it's handled outside safe()'s {ok,error} envelope.
    ipcMain.handle('linkedin:open-login', async () => {
      try {
        return await this.openLoginWindow();
      } catch (err) {
        return { authenticated: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    // Whether the persisted partition currently holds a LinkedIn auth cookie.
    ipcMain.handle('linkedin:session-state', () => this.sessionState());
    // Sign out: wipe the persisted partition (cookies/storage). Works without
    // the driver being attached, so it's usable from the onboarding flow too.
    ipcMain.handle('linkedin:clear-session', async () => {
      try {
        await this.clearSession();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    // The last signed-in member (name + avatar) for the connect screen's
    // "Continue as …" tile. Returns null when no one has signed in yet.
    ipcMain.handle('linkedin:last-account', () => this.lastAccount());
  }

  public unregisterIpc(): void {
    for (const ch of [
      'browser:attach',
      'browser:detach',
      'browser:navigate',
      'browser:back',
      'browser:forward',
      'browser:reload',
      'browser:login',
      'browser:bounds',
      'linkedin:open-login',
      'linkedin:session-state',
      'linkedin:clear-session',
      'linkedin:last-account',
    ]) {
      ipcMain.removeHandler(ch);
    }
  }

  // -- Attach / detach ------------------------------------------------------

  /**
   * Ensure the LinkedIn view is docked, navigated, and the driver is attached to
   * it over CDP. Idempotent and self-healing: a second call with the view alive
   * just re-asserts bounds; if the view was destroyed it is recreated.
   */
  public async attach(opts: { freshFeed?: boolean } = {}): Promise<void> {
    if (!this.attaching) {
      this.attaching = this.doAttach(opts).finally(() => {
        this.attaching = null;
      });
    }
    await this.attaching;
  }

  private async doAttach(opts: { freshFeed?: boolean } = {}): Promise<void> {
    if (!this.enabled) return;
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    const exists = !!this.view && !this.view.webContents.isDestroyed();

    if (opts.freshFeed) {
      // Post sign-in hand-off (onboarding "Finish" / re-login). The docked view
      // may have been parked on the LinkedIn login page during the previous
      // sign-out, so we must NOT just re-show it — that's what made the feed
      // open on the login screen again. Instead: build/reuse the view, navigate
      // it to the feed WHILE IT IS STILL DETACHED, wait for it to settle, and
      // only THEN dock it. The pane therefore appears directly on the feed —
      // no flash of the stale login page.
      if (!exists) this.view = this.createView();
      await this.loadAndSettle(FEED_URL);
      win.setBrowserView(this.view!);
      this.applyBounds();
    } else if (!exists) {
      this.view = this.createView();
      win.setBrowserView(this.view);
      this.applyBounds();
      // Kick off the first navigation. A not-signed-in user is redirected to
      // /login, which aborts this goto — benign, so swallow it.
      this.view.webContents.loadURL(FEED_URL).catch(() => {});
    } else {
      // View already live — make sure it's the window's active view and sized.
      // Don't navigate: a plain re-show (window re-open) must not disrupt the
      // page the user was already on.
      win.setBrowserView(this.view!);
      this.applyBounds();
    }

    // Attach the Playwright driver to the (now LinkedIn) view over CDP. Lazy +
    // idempotent; in connect mode this locates the view's page rather than
    // launching a browser.
    await this.getDriver().launch();

    if (opts.freshFeed) {
      // The feed's own load event fired during loadAndSettle — BEFORE the driver
      // attached — so the navigation-driven auth sync ran too early to confirm
      // login or capture the member. Now that the driver is attached to the feed,
      // run it explicitly: this is what makes "sign in on step 2 → Finish → feed"
      // both flip the panel to signed-in AND remember the member (name + avatar)
      // for the next "Continue as …" tile.
      void this.maybeSyncAuth(this.activeContents()?.getURL() ?? FEED_URL);
    }
  }

  /**
   * Navigate the (possibly detached) docked view to `url` and resolve once it
   * has finished loading — or after a short timeout, so a slow/long-polling page
   * never hangs the attach. Used to defer docking until the page is ready.
   */
  private loadAndSettle(url: string, timeoutMs = 9000): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wc.off('did-stop-loading', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      wc.on('did-stop-loading', finish);
      // Redirects abort the in-flight goto (ERR_ABORTED) — benign; the
      // did-stop-loading / timeout path settles us regardless.
      wc.loadURL(url).catch(() => undefined);
    });
  }

  /** Build the docked view: persistent session, pinned UA, popup handling. */
  private createView(): BrowserView {
    const view = new BrowserView({
      webPreferences: {
        partition: SESSION_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const wc = view.webContents;
    wc.setUserAgent(PINNED_USER_AGENT);
    // Belt-and-braces: also pin the UA on the partition's session so any
    // sub-resource / new webContents in the partition matches.
    try {
      session.fromPartition(SESSION_PARTITION).setUserAgent(PINNED_USER_AGENT);
    } catch {
      /* non-fatal */
    }

    // Auth popups (Google/Apple/Microsoft "Continue with…") open as real,
    // on-screen windows so the user can complete OAuth; any OTHER popup is
    // pushed to the system browser rather than spawned in-app.
    wc.setWindowOpenHandler(({ url }) => {
      if (isAuthPopupUrl(url)) return { action: 'allow' };
      void shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    // Self-heal: if the view's renderer crashes/dies, drop it and re-attach on
    // the next tick so the pane comes back (and the driver re-locates the page)
    // instead of leaving a dead, un-drivable view.
    wc.on('render-process-gone', (_e, details) => {
      process.stderr.write(`[embedded] view render process gone: ${details.reason}\n`);
      if (this.view?.webContents === wc) this.view = null;
      setTimeout(() => {
        void this.attach().catch((err) => {
          process.stderr.write(`[embedded] recovery re-attach failed: ${String(err)}\n`);
        });
      }, 300);
    });

    // Reflect navigation + load state into the renderer's URL bar / spinner.
    wc.on('did-start-loading', () => this.send('browser:loading', { loading: true }));
    wc.on('did-stop-loading', () => {
      this.send('browser:loading', { loading: false });
      const url = wc.getURL();
      this.send('browser:url', { url });
      void this.maybeSyncAuth(url);
    });
    wc.on('did-navigate', (_e, url) => {
      this.send('browser:url', { url });
      void this.maybeSyncAuth(url);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        this.send('browser:url', { url });
        void this.maybeSyncAuth(url);
      }
    });

    return view;
  }

  /** Stop showing the view (keeps it + its session alive for a fast re-attach). */
  public async detach(): Promise<void> {
    const win = this.win;
    if (win && !win.isDestroyed() && this.view) {
      win.removeBrowserView(this.view);
    }
  }

  /** Destroy the view entirely (on quit). */
  public destroy(): void {
    const win = this.win;
    if (win && !win.isDestroyed() && this.view) {
      win.removeBrowserView(this.view);
    }
    const wc = this.view?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.close();
    }
    this.view = null;
  }

  // -- Bounds ---------------------------------------------------------------

  /** Dock the view to the pane rectangle the renderer measured. */
  private setBounds(b: Bounds): void {
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return;
    this.bounds = {
      x: Math.max(0, Math.round(b.x)),
      y: Math.max(0, Math.round(b.y)),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height)),
    };
    this.applyBounds();
  }

  private applyBounds(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const b = this.bounds ?? this.fallbackBounds();
    this.view.setBounds(b);
  }

  /**
   * A reasonable initial rectangle before the renderer reports the real one, so
   * the view isn't zero-sized for the first frame. The renderer corrects this
   * within a tick via `browser:bounds`.
   */
  private fallbackBounds(): Bounds {
    const win = this.win;
    if (win && !win.isDestroyed()) {
      const { width, height } = win.getContentBounds();
      const sidebar = 320;
      const toolbar = 48;
      return { x: sidebar, y: toolbar, width: Math.max(0, width - sidebar), height: Math.max(0, height - toolbar) };
    }
    return { x: 320, y: 48, width: 960, height: 720 };
  }

  // -- Navigation -----------------------------------------------------------

  /**
   * Open LinkedIn's OWN login page in a dedicated in-app window. The user types
   * their credentials directly on linkedin.com — so 2FA / Google SSO work and we
   * never see the password — and the persistent partition (`persist:linkedin`)
   * stores the resulting session, shared with the docked driver view. Resolves
   * once the user reaches the logged-in app (feed/home) or closes the window.
   */
  public openLoginWindow(): Promise<{ authenticated: boolean }> {
    return new Promise((resolve) => {
      const parent = this.win && !this.win.isDestroyed() ? this.win : undefined;
      const loginWin = new BrowserWindow({
        width: 520,
        height: 720,
        ...(parent ? { parent } : {}),
        show: false,
        center: true,
        title: 'Sign in to LinkedIn',
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: SESSION_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      // Show only once the first paint is ready, so the window never flashes
      // blank/white (which reads as "nothing happened").
      loginWin.once('ready-to-show', () => {
        loginWin.show();
        loginWin.focus();
      });

      const wc = loginWin.webContents;
      wc.setUserAgent(PINNED_USER_AGENT);
      try {
        session.fromPartition(SESSION_PARTITION).setUserAgent(PINNED_USER_AGENT);
      } catch {
        /* non-fatal */
      }
      // Allow identity-provider popups ("Continue with Google", etc.); push any
      // other popup to the system browser.
      wc.setWindowOpenHandler(({ url }) => {
        if (isAuthPopupUrl(url)) return { action: 'allow' };
        void shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      });

      // Diagnostics: surface load failures so a blank window isn't silent.
      wc.on('did-fail-load', (_e, code, desc, url) => {
        if (code === -3) return; // ERR_ABORTED from a redirect — benign
        process.stderr.write(`[login] did-fail-load ${code} ${desc} ${url}\n`);
      });

      let settled = false;
      const finish = (authenticated: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ authenticated });
        if (!loginWin.isDestroyed()) loginWin.close();
      };

      // A logged-in member lands on the feed / profile / network home; treat
      // reaching any of those as a successful sign-in. /login and /checkpoint
      // (2FA) are NOT success — we keep waiting until they clear.
      const onNav = (_e: unknown, url: string): void => {
        if (/linkedin\.com\/(feed|in\/|mynetwork|home|sales|jobs)/i.test(url)) finish(true);
      };
      wc.on('did-navigate', onNav);
      wc.on('did-navigate-in-page', onNav);
      loginWin.on('closed', () => finish(false));

      wc.loadURL(LOGIN_URL).catch(() => {});
    });
  }

  /** True if the persisted LinkedIn partition holds an auth cookie (`li_at`). */
  public async sessionState(): Promise<{ authenticated: boolean }> {
    try {
      const cookies = await session
        .fromPartition(SESSION_PARTITION)
        .cookies.get({ domain: '.linkedin.com' });
      return { authenticated: cookies.some((c) => c.name === 'li_at') };
    } catch {
      return { authenticated: false };
    }
  }

  /** Sign out: clear all cookies/storage in the persisted LinkedIn partition. */
  public async clearSession(): Promise<void> {
    await session.fromPartition(SESSION_PARTITION).clearStorageData();
    // Allow the NEXT sign-in (possibly a different member) to refresh the
    // remembered account. We intentionally keep last-account.json itself so the
    // connect screen can still show a "Continue as …" tile for this member.
    this.accountCaptured = false;
    // If the docked view is live, send it back to the login page so the UI
    // reflects the signed-out state immediately.
    const wc = this.activeContents();
    if (wc) wc.loadURL(LOGIN_URL).catch(() => {});
  }

  private async navigate(url: string): Promise<void> {
    await this.attach();
    const wc = this.activeContents();
    if (!wc) return;
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await wc.loadURL(target).catch((err) => {
      process.stderr.write(`[embedded] navigate failed: ${String(err)}\n`);
    });
  }

  private async goBack(): Promise<void> {
    const wc = this.activeContents();
    // navigationHistory is the Electron 28+ API; canGoBack/goBack are the
    // long-standing aliases still present here.
    if (wc?.canGoBack()) wc.goBack();
  }

  private async goForward(): Promise<void> {
    const wc = this.activeContents();
    if (wc?.canGoForward()) wc.goForward();
  }

  private async reload(): Promise<void> {
    this.activeContents()?.reload();
  }

  // -- Helpers --------------------------------------------------------------

  private activeContents(): Electron.WebContents | null {
    const wc = this.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /**
   * Re-check the driver's auth state after the view settles on a navigation, so
   * a login completed *inside* the embedded view flips the sidebar pill to
   * "signed in" (and enables Log out) without waiting for the next MCP call or
   * a restart. `getStatus()` only returns a cached flag, so we must re-run
   * `refreshSession()` here and push the fresh snapshot to the renderer.
   *
   * Three safeguards keep this from hijacking the user's browsing:
   *   - We pass `navigate: false`, so the login check inspects the page where
   *     it sits and NEVER issues a goto — without this, the slow path's /feed
   *     navigation fires another navigation event and loops the reload.
   *   - We skip login/authwall/checkpoint pages (no point re-checking there).
   *   - `authSyncing` prevents overlapping re-checks from stacking.
   */
  private async maybeSyncAuth(url: string): Promise<void> {
    if (!this.enabled || this.authSyncing) return;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    if (!/(^|\.)linkedin\.com$/i.test(host)) return;
    if (/\/(login|authwall|checkpoint|signup)\b/i.test(url)) return;

    this.authSyncing = true;
    try {
      const driver = this.getDriver();
      // Passive check — must NOT navigate. The slow login path would otherwise
      // goto /feed, firing another navigation event and looping the reload.
      await driver.refreshSession({ navigate: false });
      this.send('driver:status-changed', driver.getStatus());
      // Once we know we're signed in, remember the member (name + avatar) so the
      // connect screen can offer a one-tap re-login tile after a future sign-out.
      if (driver.getStatus().isLoggedIn) void this.captureAccount();
    } catch {
      /* non-fatal — the renderer's interval poll is the fallback */
    } finally {
      this.authSyncing = false;
    }
  }

  /**
   * Best-effort: scrape the signed-in member's display name + avatar from the
   * live page and persist them (avatar inlined as a data URL) to
   * {@link lastAccountPath}, so the connect screen can show a "Continue as …"
   * tile after sign-out. Runs at most once per session and never throws.
   */
  private async captureAccount(): Promise<void> {
    if (this.accountCaptured) return;
    const wc = this.activeContents();
    if (!wc) return;
    try {
      // Read name + avatar URL from the DOM. LinkedIn hashes class names, so we
      // key off the avatar image's stable `displayphoto` src and its alt text
      // (the member's name) rather than brittle selectors.
      const found = (await wc.executeJavaScript(
        `(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          const pick = imgs.find(i => /displayphoto/i.test(i.src || '') && (i.alt || '').trim() && i.naturalWidth > 0 && i.naturalWidth <= 200)
                    || imgs.find(i => /displayphoto/i.test(i.src || '') && (i.alt || '').trim());
          if (!pick) return null;
          return { name: (pick.alt || '').replace(/^Photo of\\s*/i, '').trim(), avatarUrl: pick.src };
        })()`,
        true,
      )) as { name?: string; avatarUrl?: string } | null;
      if (!found || !found.name) return;

      this.accountCaptured = true;
      const avatarDataUrl = found.avatarUrl
        ? await this.fetchImageAsDataUrl(found.avatarUrl)
        : undefined;
      const record: LastAccount = {
        name: found.name,
        ...(avatarDataUrl ? { avatarDataUrl } : {}),
        capturedAt: Date.now(),
      };
      await fs.writeFile(lastAccountPath(), JSON.stringify(record), 'utf8').catch(() => undefined);
    } catch {
      /* best-effort — a missing tile is harmless */
    }
  }

  /** Read the remembered member, or null if none / unreadable. */
  public async lastAccount(): Promise<{ name: string; avatarDataUrl?: string } | null> {
    try {
      const raw = await fs.readFile(lastAccountPath(), 'utf8');
      const j = JSON.parse(raw) as Partial<LastAccount>;
      if (j && typeof j.name === 'string' && j.name) {
        return { name: j.name, ...(j.avatarDataUrl ? { avatarDataUrl: j.avatarDataUrl } : {}) };
      }
    } catch {
      /* no remembered account */
    }
    return null;
  }

  /**
   * Fetch an image through the LinkedIn partition (so cookie-gated CDN URLs
   * resolve) and return it as a `data:` URL. Resolves null on any failure.
   */
  private fetchImageAsDataUrl(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const req = net.request({ url, session: session.fromPartition(SESSION_PARTITION) });
        const chunks: Buffer[] = [];
        req.on('response', (res) => {
          const ctRaw = res.headers['content-type'];
          const ct = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) || 'image/jpeg';
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (!buf.length) return resolve(null);
            resolve(`data:${ct};base64,${buf.toString('base64')}`);
          });
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  /** Run an action, normalizing errors into a structured envelope for IPC. */
  private async safe(
    fn: () => void | Promise<void>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
