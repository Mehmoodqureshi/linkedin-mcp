/**
 * Electron Main process entry point.
 *
 * This is the orchestrator for the whole application. It owns:
 *   - the app lifecycle (ready / window-all-closed / activate / before-quit)
 *   - the control-panel BrowserWindow (UI mode)
 *   - the tray icon + menu
 *   - the singleton Playwright LinkedIn driver
 *   - the MCP stdio server (so Claude Desktop can drive automation)
 *   - the IPC handler registrations
 *
 * Two launch modes:
 *   1. "MCP mode"  — Claude Desktop spawns this binary as an MCP command. stdin/stdout
 *                    are wired to the MCP Server. We run headless-ish: tray + main only,
 *                    no renderer window is required.
 *   2. "UI mode"   — normal double-click launch. We show the renderer control panel.
 *
 * Exports nothing: this module is an entry point, executed for its side effects.
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain } from 'electron';
import { join } from 'node:path';

import { getInstance, type LinkedInDriver } from '../driver/linkedin';
import {
  startMcpServer,
  stopMcpServer,
  isMcpServerRunning,
  startMcpSocketServer,
  stopMcpSocketServer,
} from '../mcp/server';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc-handlers';
import type { McpStatusSnapshot } from './ipc-handlers';
import { EmbeddedBrowser } from './embedded-browser';
import { runStdioBridge } from './mcp-bridge';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

/** The one and only Playwright-backed LinkedIn driver. */
let driver: LinkedInDriver | null = null;

/** The control-panel window (UI mode). Null in headless MCP mode (until activated). */
let mainWindow: BrowserWindow | null = null;

/** The system tray icon. Kept at module scope so it is not garbage collected. */
let tray: Tray | null = null;

/** Hosts the native in-app LinkedIn BrowserView docked in the right pane. */
let embedded: EmbeddedBrowser | null = null;

/**
 * Whether stdio is wired to a pipe/socket — how an MCP client (Claude Desktop)
 * spawns a child, versus a GUI launch (Finder/dock) where stdin is /dev/null
 * and a terminal launch where it is a TTY. We must NOT treat "no TTY" alone as
 * MCP mode: a double-clicked .app has no TTY yet is a normal UI launch, and
 * treating it as MCP would bind the (empty) stdin, hit EOF, and quit instantly.
 */
function stdioIsPipe(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { fstatSync } = require('node:fs') as typeof import('node:fs');
  for (const fd of [0, 1]) {
    try {
      const st = fstatSync(fd);
      if (st.isFIFO() || st.isSocket()) return true;
    } catch {
      /* fd may be closed/unavailable — ignore */
    }
  }
  return false;
}

/** True when launched as an MCP command (stdio is owned by the MCP server). */
const isMcpMode =
  process.argv.includes('--mcp') ||
  process.env.LINKEDIN_MCP_STDIO === '1' ||
  // Autodetect: an MCP client pipes stdio. A GUI/terminal launch does not.
  (process.env.LINKEDIN_MCP_AUTODETECT !== '0' && stdioIsPipe());

const isDev = !app.isPackaged;

/**
 * In UI mode we render LinkedIn in a native in-app `BrowserView` and attach the
 * Playwright driver to it over CDP (see EmbeddedBrowser + BrowserManager connect
 * mode). That requires Electron's Chromium to expose a remote-debugging
 * endpoint, which MUST be enabled via command-line switches BEFORE `app.ready`.
 *
 *   - `remote-debugging-port` opens the CDP server (localhost only).
 *   - `remote-allow-origins=*` is required for Playwright's `connectOverCDP`
 *     websocket handshake on Chromium ≥115 (otherwise it is refused).
 *   - `disable-blink-features=AutomationControlled` trims the automation tell.
 *
 * We skip all of this in MCP mode, where the driver launches its own Chromium.
 *
 * SECURITY NOTE: the debug port lets ANY local process that finds it attach to
 * Chromium and drive the logged-in LinkedIn session. We bind to localhost and
 * randomize the port per launch (instead of a fixed, guessable one) to raise the
 * bar; this still assumes the local machine is trusted, which is the same trust
 * model as a normal browser profile on disk. An explicit LINKEDIN_CDP_PORT wins.
 */
const CDP_PORT =
  Number(process.env.LINKEDIN_CDP_PORT) ||
  // Ephemeral/private range (49152–65535), chosen fresh each launch.
  49152 + Math.floor(Math.random() * 16000);
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
if (!isMcpMode) {
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
}

/**
 * Build the MCP status snapshot the renderer + tray consume. The MCP server
 * exposes only `isMcpServerRunning()`, so we derive the richer snapshot here.
 */
function getMcpStatus(): McpStatusSnapshot {
  return {
    running: isMcpServerRunning(),
    transport: 'stdio',
    connectedClients: isMcpServerRunning() ? 1 : 0,
  };
}

/**
 * Local IPC endpoint the running (UI-mode) instance serves MCP over, so an
 * MCP-mode process spawned by Claude Desktop can bridge into it and drive the
 * same in-app browser. Windows needs a named pipe; elsewhere a Unix socket in
 * userData.
 */
function bridgeSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\linkedin-mcp-bridge';
  }
  return join(app.getPath('userData'), 'mcp-bridge.sock');
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
// Two LinkedIn sessions racing each other trips bot-detection, and two MCP
// servers fighting over the same stdio would corrupt the protocol stream.

const gotLock = app.requestSingleInstanceLock();

/**
 * A second MCP-mode process (Claude Desktop) that loses the lock doesn't quit —
 * it bridges into the already-running app instead, so Claude drives the SAME
 * visible browser. A second UI-mode launch just focuses the existing window.
 */
const runAsBridge = !gotLock && isMcpMode;

if (runAsBridge) {
  // Don't init the app (no driver/window/stdio server) — just pump bytes to the
  // primary. Wait for `whenReady` only so `app.getPath` is resolvable.
  app.on('window-all-closed', () => {});
  app
    .whenReady()
    .then(() => runStdioBridge(bridgeSocketPath(), () => app.quit()))
    .catch(() => app.quit());
} else if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'LinkedIn MCP',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Standalone React "Connect Your LinkedIn" screen. When LINKEDIN_CONNECT_UI=1
  // we render that page instead of the control panel and skip docking the
  // embedded BrowserView (which would otherwise cover the screen).
  const connectUi = process.env.LINKEDIN_CONNECT_UI === '1';

  // Whether to dock the native LinkedIn BrowserView. True only for the control
  // panel; the connect/onboarding screens render full-window with no view.
  // Mutated by the async entry decision below before 'ready-to-show' fires.
  let dockView = false;

  // Dock the native LinkedIn BrowserView into this window once the UI is up.
  // attach() creates the view, navigates it to LinkedIn, then attaches the
  // Playwright driver over CDP — so the right pane is a real, interactive
  // browser, not a screencast. NOTE: the renderer must have finished loading
  // before the driver connects (a blank host target churns and wedges
  // connectOverCDP), so we attach on 'ready-to-show', which fires post-load.
  win.once('ready-to-show', () => {
    win.show();
    if (!dockView) return;
    void embedded?.attach().catch((err) => {
      process.stderr.write(`[main] embedded attach failed: ${String(err)}\n`);
    });
  });

  // Hide instead of destroy so the tray can re-show it instantly and the
  // app keeps running as an MCP server in the background.
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // Pick the entry screen, then load it. The page choice is async (it inspects
  // the saved session + remembered member), but it resolves before the slow
  // 'ready-to-show' fires, so dockView is set in time for the attach decision.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  void (async () => {
    let page = 'index.html';
    let hash: string | undefined;

    if (connectUi) {
      page = 'connect.html';
    } else {
      // Launch profile picker: if we remember a member from a previous sign-in,
      // greet with the step-2 chooser — a one-tap "Continue as …" tile (which
      // resumes the preserved session directly, no password) plus "Use a
      // different account". A brand-new user (nothing remembered) instead lands
      // on the control panel, whose pane hosts the first-run login.
      const last = await embedded?.lastAccount().catch(() => null);
      if (last) {
        page = 'connect.html';
        hash = 'linkedin';
      }
    }

    dockView = page === 'index.html';
    if (dockView) embedded?.setWindow(win);

    if (isDev && devServerUrl) {
      await win.loadURL(devServerUrl);
    } else {
      await win.loadFile(
        join(__dirname, `../renderer/${page}`),
        hash ? { hash } : undefined,
      );
    }
  })();

  mainWindow = win;
  return win;
}

function showWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function resolveTrayIconPath(): string {
  // In dev the resources sit next to the project root; when packaged they are
  // unpacked alongside the app.
  const base = isDev
    ? join(app.getAppPath(), 'resources')
    : join(process.resourcesPath, 'resources');
  return join(base, 'tray-icon.png');
}

function buildTrayMenu(): Menu {
  const mcp = getMcpStatus();
  const driverStatus = driver?.getStatus().status ?? 'stopped';

  return Menu.buildFromTemplate([
    {
      label: `MCP server: ${mcp.running ? 'running' : 'stopped'}`,
      enabled: false,
    },
    {
      label: `Driver: ${driverStatus}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show / Hide Window',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu(): void {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray(): void {
  if (tray) return;

  let image = nativeImage.createFromPath(resolveTrayIconPath());
  if (image.isEmpty()) {
    // Fall back to a tiny transparent image so the app still boots if the
    // icon asset is missing (e.g. during early development).
    image = nativeImage.createEmpty();
  }
  // Template image so macOS renders it correctly in light/dark menu bars.
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip('LinkedIn MCP');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleWindow());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false;

async function bootstrap(): Promise<void> {
  // 0. In UI mode the browser is the native in-app BrowserView, and the driver
  //    ATTACHES to it over CDP rather than launching its own Chromium. Point the
  //    driver at the connect endpoint (env is read by the driver's config). The
  //    view is a genuine headed Electron Chromium, so identity providers (Google
  //    sign-in) accept it where they reject headless. Snappy ops: no per-op
  //    slowMo for the interactive view. Explicit env always wins.
  if (!isMcpMode) {
    if (process.env.LINKEDIN_BROWSER_MODE === undefined) {
      process.env.LINKEDIN_BROWSER_MODE = 'connect';
    }
    if (process.env.LINKEDIN_CDP_ENDPOINT === undefined) {
      process.env.LINKEDIN_CDP_ENDPOINT = CDP_ENDPOINT;
    }
    if (process.env.LINKEDIN_SLOWMO === undefined) {
      process.env.LINKEDIN_SLOWMO = '0';
    }
  }

  // 1. Create the driver singleton (lazy browser attach/launch happens inside).
  driver = getInstance();

  // 2. Register IPC handlers, giving them access to the driver + MCP controls.
  registerIpcHandlers({
    getDriver: () => {
      if (!driver) throw new Error('Driver not initialized');
      return driver;
    },
    getMcpStatus,
    showWindow,
  });

  // 2b. The native embedded browser — only meaningful in UI mode, but the IPC
  //     surface is harmless to register either way.
  embedded = new EmbeddedBrowser(() => {
    if (!driver) throw new Error('Driver not initialized');
    return driver;
  }, !isMcpMode);
  embedded.registerIpc();

  // 2c. Onboarding hand-off: when the connect-UI flow finishes, swap the window
  //     from connect.html to the main control panel and dock the LinkedIn view.
  ipcMain.handle('app:open-main', async () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { ok: false };
    await win.loadFile(join(__dirname, '../renderer/index.html'));
    embedded?.setWindow(win);
    // freshFeed: the user just signed in, so dock the view straight onto the
    // feed (navigated off-screen first) rather than re-showing whatever page it
    // was parked on during sign-out — otherwise the pane reopens on the login
    // screen even though we're now authenticated.
    await embedded?.attach({ freshFeed: true }).catch((err) => {
      process.stderr.write(`[main] embedded attach after finish failed: ${String(err)}\n`);
    });
    return { ok: true };
  });

  // 2d. Reverse hand-off (used on logout): swap the control panel back to the
  //     connect-UI flow at step 2 ("Connect Your LinkedIn").
  //
  //     This is a SOFT sign-out: we deliberately KEEP the LinkedIn session in the
  //     partition. That's what lets step 2 show the remembered member's avatar as
  //     a "Continue as …" tile that resumes the live session in one tap — no
  //     re-typing credentials. (A hard sign-out that wipes the session is offered
  //     separately on that screen via "Use a different account".) We only detach
  //     the docked view first, so it doesn't cover the connect screen.
  ipcMain.handle('app:open-connect', async (_e, step?: unknown) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { ok: false };
    await embedded?.detach();
    const hash = step === 'linkedin' || step === 'mcp' ? String(step) : undefined;
    await win.loadFile(
      join(__dirname, '../renderer/connect.html'),
      hash ? { hash } : undefined,
    );
    return { ok: true };
  });

  // 3. Boot the MCP stdio server. In MCP mode this binds stdin/stdout to the
  //    @modelcontextprotocol/sdk Server immediately so Claude Desktop can talk
  //    to us. In UI mode we still start it (idempotent) so the renderer can
  //    report connection status. The MCP tool layer resolves its own driver
  //    singleton via getInstance(), so no driver is threaded through here.
  await startMcpServer();

  // UI-mode primary also serves MCP over a local socket so a Claude-Desktop MCP
  // process can bridge in and drive THIS visible browser (see mcp-bridge.ts).
  // Non-fatal if it fails — the desktop app still works standalone.
  if (!isMcpMode) {
    try {
      await startMcpSocketServer(bridgeSocketPath());
    } catch (err) {
      process.stderr.write(`[main] MCP socket server failed to start: ${String(err)}\n`);
    }
  }
  refreshTrayMenu();

  // 4. Tray is always present (both modes).
  createTray();

  // 5. Only show the control panel in UI mode. In MCP mode the process runs
  //    headless-ish until the user explicitly opens the window from the tray.
  if (!isMcpMode) {
    createWindow();
  }
}

// Bridge processes never bootstrap the app (no driver/window/stdio server) —
// they only pump bytes to the primary, wired up in the single-instance block.
if (!runAsBridge) {
  app.whenReady().then(bootstrap).catch((err) => {
    // Never write human-readable text to stdout in MCP mode — it would corrupt
    // the JSON-RPC stream. Route everything to stderr.
    process.stderr.write(`[main] fatal during bootstrap: ${String(err)}\n`);
    app.quit();
  });

  app.on('activate', () => {
    // macOS: re-create / re-show the window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showWindow();
    }
  });
}

app.on('window-all-closed', () => {
  // Do NOT quit when all windows are closed: we keep running as a background
  // MCP server + tray app. The user quits explicitly via the tray menu.
  // (On non-macOS this would normally quit; we intentionally override.)
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', (event) => {
  // Tear down async resources cleanly before the process exits.
  event.preventDefault();
  void (async () => {
    try {
      embedded?.unregisterIpc();
      embedded?.destroy();
      unregisterIpcHandlers();
      await stopMcpSocketServer();
      await stopMcpServer();
      await driver?.close();
    } catch (err) {
      process.stderr.write(`[main] error during shutdown: ${String(err)}\n`);
    } finally {
      driver = null;
      if (tray && !tray.isDestroyed()) {
        tray.destroy();
        tray = null;
      }
      app.exit(0);
    }
  })();
});

// Defensive: make sure renderer-driven status pings refresh the tray too.
ipcMain.on('ui:refresh-tray', () => refreshTrayMenu());
