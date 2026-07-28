/**
 * CDP endpoint discovery — the bridge that lets a standalone (npx / MCP-client)
 * driver process attach to the Chromium of an ALREADY-RUNNING desktop app.
 *
 * The driver is connect-only: it never launches its own Chromium, it attaches
 * over CDP to the app's in-app BrowserView (see BrowserManager). The app opens a
 * randomized, localhost-only remote-debugging port per launch; a separate driver
 * process (spawned by Claude Desktop / Claude Code / `npx`) has no way to know
 * that port. This module is the rendezvous:
 *
 *   - the app (main process) calls `advertiseCdpEndpoint()` on boot to publish
 *     its endpoint + pid to a small JSON file, and `clearCdpEndpoint()` on quit;
 *   - a standalone driver calls `discoverCdpEndpoint()` to read it back.
 *
 * The file lives at a STABLE, Electron-independent path
 * (`$LINKEDIN_MCP_USERDATA` or `~/.linkedin-mcp/cdp-endpoint.json`) so both the
 * Electron app (whose real userData dir is OS-specific, e.g. `~/Library/…`) and
 * a plain Node process compute the SAME location without importing Electron.
 *
 * Everything is best-effort and defensive: a missing / malformed / stale file is
 * treated as "no app running" rather than an error, and `discoverCdpEndpoint()`
 * drops an advert whose advertising process is no longer alive (crash / SIGKILL
 * that skipped `clearCdpEndpoint()`), so a dead app never wedges the driver.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The published advert shape. `pid` powers the staleness check. */
interface CdpAdvert {
  endpoint: string;
  port: number;
  pid: number;
}

/**
 * The rendezvous directory. Deliberately NOT Electron's `userData` (which is
 * OS-specific and unknowable to a plain Node process); a fixed home-relative
 * path both sides can derive identically. `$LINKEDIN_MCP_USERDATA` overrides it.
 */
function discoveryDir(): string {
  return (
    process.env.LINKEDIN_MCP_USERDATA ??
    join(homedir() || process.env.HOME || process.env.USERPROFILE || process.cwd(), '.linkedin-mcp')
  );
}

/** Absolute path to the CDP advert file. */
export function cdpDiscoveryPath(): string {
  return join(discoveryDir(), 'cdp-endpoint.json');
}

/**
 * Publish the running app's CDP endpoint so standalone drivers can attach.
 * Best-effort: a write failure is logged to stderr and swallowed (discovery is
 * an optimization, never a hard dependency of the app itself).
 */
export function advertiseCdpEndpoint(endpoint: string, port: number): void {
  try {
    mkdirSync(discoveryDir(), { recursive: true });
    const advert: CdpAdvert = { endpoint, port, pid: process.pid };
    writeFileSync(cdpDiscoveryPath(), JSON.stringify(advert), 'utf8');
  } catch (err) {
    process.stderr.write(
      `[cdp-discovery] failed to advertise endpoint (non-fatal): ${(err as Error).message}\n`,
    );
  }
}

/** Remove the advert file on app shutdown. Best-effort; a missing file is fine. */
export function clearCdpEndpoint(): void {
  try {
    rmSync(cdpDiscoveryPath(), { force: true });
  } catch {
    /* best effort — a locked/absent file must never block quit */
  }
}

/** Whether `pid` still names a live process. Unknowable → assume alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, sends nothing.
    return true;
  } catch (e) {
    // ESRCH = no such process (dead). EPERM = alive but owned by another user.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Read back a live app's CDP endpoint, or null when none is running. Drops a
 * stale advert whose advertising process has exited so a crashed app can't
 * leave the driver pointed at a dead port.
 */
export function discoverCdpEndpoint(): string | null {
  try {
    const path = cdpDiscoveryPath();
    if (!existsSync(path)) return null;
    const advert = JSON.parse(readFileSync(path, 'utf8')) as Partial<CdpAdvert>;
    if (!advert || typeof advert.endpoint !== 'string' || typeof advert.pid !== 'number') {
      return null;
    }
    if (!processAlive(advert.pid)) {
      // Stale advert from a dead app: clear it so we don't re-check every call.
      clearCdpEndpoint();
      return null;
    }
    return advert.endpoint;
  } catch {
    return null;
  }
}
