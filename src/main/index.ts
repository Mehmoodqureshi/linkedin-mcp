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
import { startMcpServer, stopMcpServer, isMcpServerRunning } from '../mcp/server';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc-handlers';
import type { McpStatusSnapshot } from './ipc-handlers';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

/** The one and only Playwright-backed LinkedIn driver. */
let driver: LinkedInDriver | null = null;

/** The control-panel window (UI mode). Null in headless MCP mode (until activated). */
let mainWindow: BrowserWindow | null = null;

/** The system tray icon. Kept at module scope so it is not garbage collected. */
let tray: Tray | null = null;

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

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
// Two LinkedIn sessions racing each other trips bot-detection, and two MCP
// servers fighting over the same stdio would corrupt the protocol stream.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
    width: 900,
    height: 700,
    minWidth: 640,
    minHeight: 480,
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

  win.once('ready-to-show', () => {
    win.show();
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

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

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
  // 1. Create the driver singleton (lazy browser launch happens inside).
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

  // 3. Boot the MCP stdio server. In MCP mode this binds stdin/stdout to the
  //    @modelcontextprotocol/sdk Server immediately so Claude Desktop can talk
  //    to us. In UI mode we still start it (idempotent) so the renderer can
  //    report connection status. The MCP tool layer resolves its own driver
  //    singleton via getInstance(), so no driver is threaded through here.
  await startMcpServer();
  refreshTrayMenu();

  // 4. Tray is always present (both modes).
  createTray();

  // 5. Only show the control panel in UI mode. In MCP mode the process runs
  //    headless-ish until the user explicitly opens the window from the tray.
  if (!isMcpMode) {
    createWindow();
  }
}

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
      unregisterIpcHandlers();
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
