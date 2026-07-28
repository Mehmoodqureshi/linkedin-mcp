/**
 * ensure-app — resolve a CDP endpoint to attach to, launching the desktop app
 * if none is running.
 *
 * The driver is connect-only: it attaches to the LinkedIn desktop app's Chromium
 * over CDP. When a SEPARATE server process (the `.mcpb` bundle / `npx` path)
 * starts and no app is running, there is nothing to attach to. Rather than fail,
 * this module brings the app up itself and waits for it to advertise its endpoint
 * (see cdp-discovery) — so a new user's only manual step is the LinkedIn login,
 * never "also remember to start the app".
 *
 * Launch is best-effort and fully overridable:
 *   - `LINKEDIN_CDP_ENDPOINT`      — skip everything, use this endpoint verbatim.
 *   - `LINKEDIN_AUTOLAUNCH_APP=0`  — never launch; only discover (error if absent).
 *   - `LINKEDIN_APP_CMD`           — exact command to launch the app, space-split
 *                                    (e.g. `npx electron .` in dev, or a packaged
 *                                    app path). Overrides the platform default.
 *
 * We spawn detached + unref'd so the GUI app outlives this resolver, then poll
 * `discoverCdpEndpoint()` until the app advertises or we time out.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { discoverCdpEndpoint } from './cdp-discovery';

/** The installed app's product name (matches electron-builder productName). */
const APP_PRODUCT_NAME = 'LinkedIn MCP';

/** Small async sleep. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether auto-launch is enabled (default on; `LINKEDIN_AUTOLAUNCH_APP=0` opts out). */
function autoLaunchEnabled(): boolean {
  return process.env.LINKEDIN_AUTOLAUNCH_APP !== '0';
}

/**
 * The command used to launch the desktop app, as `[cmd, ...args]`.
 *
 * `LINKEDIN_APP_CMD` wins (space-split — sufficient for the path/flag shapes we
 * use; wrap in the env if you need spaces in a path). Otherwise fall back to a
 * platform default that opens the installed app by name; in a dev checkout set
 * `LINKEDIN_APP_CMD="npx electron ."`.
 */
function appLaunchCommand(): [string, string[]] | null {
  const override = process.env.LINKEDIN_APP_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return [parts[0] as string, parts.slice(1)];
  }

  // macOS: launch the installed .app by product name via Launch Services.
  if (process.platform === 'darwin') return ['open', ['-a', APP_PRODUCT_NAME]];

  // Windows: the NSIS installer (oneClick:false, perMachine:false) puts the exe
  // under %LOCALAPPDATA%\Programs\<productName>\<productName>.exe and drops a
  // Start Menu shortcut. `start "" "LinkedIn MCP"` alone does NOT resolve to
  // either, so probe the concrete install locations and launch the first that
  // exists; fall back to the bare name (which works if it's on PATH).
  if (process.platform === 'win32') {
    const candidates: string[] = [];
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(join(local, 'Programs', APP_PRODUCT_NAME, `${APP_PRODUCT_NAME}.exe`));
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(
        join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_PRODUCT_NAME}.lnk`),
      );
    }
    const found = candidates.find((p) => existsSync(p));
    // `start "" "<target>"` launches an .exe or resolves a .lnk shortcut.
    return ['cmd', ['/c', 'start', '', found ?? APP_PRODUCT_NAME]];
  }

  // Linux: rely on an override or a desktop entry / AppImage on PATH.
  return ['linkedin-mcp-app', []];
}

/** Launch the desktop app detached so it outlives this process. Best-effort. */
function launchApp(): boolean {
  const command = appLaunchCommand();
  if (!command) return false;
  const [cmd, args] = command;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    process.stderr.write(`[ensure-app] launching desktop app: ${cmd} ${args.join(' ')}\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `[ensure-app] failed to launch the desktop app (${cmd}): ${(err as Error).message}\n`,
    );
    return false;
  }
}

/**
 * Resolve a CDP endpoint to attach to, or null if none can be obtained.
 *
 *   1. explicit `LINKEDIN_CDP_ENDPOINT` → return as-is;
 *   2. an app already running → its advertised endpoint;
 *   3. otherwise (unless disabled) launch the app and poll until it advertises.
 *
 * @param timeoutMs how long to wait for a freshly-launched app to come up.
 */
export async function resolveCdpEndpoint(timeoutMs = 25_000): Promise<string | null> {
  const explicit = process.env.LINKEDIN_CDP_ENDPOINT;
  if (explicit) return explicit;

  const found = discoverCdpEndpoint();
  if (found) return found;

  if (!autoLaunchEnabled()) return null;

  if (!launchApp()) return null;

  // Poll for the app's advert. The app writes it once its BrowserView + driver
  // are up, so this also gives the window time to appear.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    const endpoint = discoverCdpEndpoint();
    if (endpoint) return endpoint;
  }
  process.stderr.write(
    `[ensure-app] desktop app did not advertise a CDP endpoint within ${timeoutMs}ms.\n`,
  );
  return null;
}
