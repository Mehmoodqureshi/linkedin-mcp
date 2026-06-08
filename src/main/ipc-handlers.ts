/**
 * Centralized ipcMain.handle registrations.
 *
 * Imported and invoked once by src/main/index.ts. Every handler is thin: it
 * validates nothing heavy here (zod validation lives in the MCP tool layer and
 * the LinkedIn action modules), dispatches onto the driver's serialized action
 * queue, and returns a normalized, structured result.
 *
 * Handlers NEVER throw across the IPC boundary in a way that leaks stack traces
 * to the renderer. They return a discriminated `{ ok: true, ... }` /
 * `{ ok: false, error }` shape so the renderer can render state instead of
 * crashing. A dead/expired LinkedIn session surfaces as a structured
 * `needs_login` error rather than an exception.
 */

import { app, ipcMain } from 'electron';

import type { LinkedInDriver } from '../driver/linkedin';
import type { PeopleFilters, JobFilters, CompanyFilters } from '../driver/actions/search';
import { getQuotaManager } from '../driver/quota';
import { TOOL_DEFINITIONS } from '../mcp/tools';
import { buildClaudeDesktopConfig } from '../mcp/claude-desktop-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpStatusSnapshot {
  running: boolean;
  transport: string;
  connectedClients: number;
}

export interface IpcContext {
  /** Lazily resolves the driver singleton (throws if not yet initialized). */
  getDriver: () => LinkedInDriver;
  /** Current MCP server status, for the renderer's MCP indicator. */
  getMcpStatus: () => McpStatusSnapshot;
  /** Bring the control-panel window to the foreground. */
  showWindow: () => void;
}

/** Uniform IPC result envelope. */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** The full list of channels this module owns — used for clean teardown. */
const CHANNELS = [
  'driver:start',
  'driver:stop',
  'driver:status',
  'linkedin:login',
  'linkedin:logout',
  'linkedin:auth-status',
  'linkedin:view-profile',
  'linkedin:search-people',
  'linkedin:search-jobs',
  'linkedin:search-companies',
  'linkedin:send-connection',
  'linkedin:send-message',
  'linkedin:read-feed',
  'linkedin:notifications',
  'linkedin:quota',
  'mcp:status',
  'mcp:tools',
  'mcp:config',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Wraps a handler body so any thrown error becomes a structured envelope.
 * A thrown `NeedsLoginError` (duck-typed via `.code === 'needs_login'`) is
 * preserved so the renderer/agent can prompt for re-authentication.
 */
async function guard<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const code = typeof e?.code === 'string' ? e.code : 'internal_error';
    const message = typeof e?.message === 'string' ? e.message : String(err);
    return fail(code, message);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpcHandlers(ctx: IpcContext): void {
  // -- Driver lifecycle -----------------------------------------------------

  ipcMain.handle('driver:start', () =>
    guard(async () => {
      await ctx.getDriver().launch();
      return ctx.getDriver().getStatus();
    }),
  );

  ipcMain.handle('driver:stop', () =>
    guard(async () => {
      await ctx.getDriver().close();
      return ctx.getDriver().getStatus();
    }),
  );

  ipcMain.handle('driver:status', () => guard(() => ctx.getDriver().getStatus()));

  // -- Authentication -------------------------------------------------------

  ipcMain.handle(
    'linkedin:login',
    (_evt, payload: { email?: string; password?: string }) =>
      guard(() =>
        ctx.getDriver().auth.login(payload?.email ?? '', payload?.password ?? ''),
      ),
  );

  ipcMain.handle('linkedin:logout', () => guard(() => ctx.getDriver().auth.logout()));

  ipcMain.handle('linkedin:auth-status', () =>
    guard(() => ctx.getDriver().auth.status()),
  );

  // -- LinkedIn actions -----------------------------------------------------
  // Each dispatches onto the driver's serialized queue inside the action module.

  ipcMain.handle('linkedin:view-profile', (_evt, payload: { url: string }) =>
    guard(() => ctx.getDriver().profile.getProfile(payload.url)),
  );

  ipcMain.handle(
    'linkedin:search-people',
    (_evt, payload: { query: string; filters?: PeopleFilters }) =>
      guard(() =>
        ctx.getDriver().search.searchPeople(payload.query, payload.filters),
      ),
  );

  ipcMain.handle(
    'linkedin:search-jobs',
    (_evt, payload: { query: string; location?: string; filters?: JobFilters }) =>
      guard(() => {
        // Back-compat: a bare `location` still works; an explicit `filters`
        // object (with location, remote, experienceLevel, datePosted, easyApply)
        // takes precedence when present.
        const filters: JobFilters | undefined =
          payload.filters ?? (payload.location ? { location: payload.location } : undefined);
        return ctx.getDriver().search.searchJobs(payload.query, filters);
      }),
  );

  ipcMain.handle(
    'linkedin:search-companies',
    (_evt, payload: { query: string; filters?: CompanyFilters }) =>
      guard(() =>
        ctx.getDriver().search.searchCompanies(payload.query, payload.filters),
      ),
  );

  ipcMain.handle(
    'linkedin:send-connection',
    (_evt, payload: { profileUrl: string; note?: string }) =>
      guard(() =>
        ctx.getDriver().connections.sendConnectionRequest(payload.profileUrl, payload.note),
      ),
  );

  ipcMain.handle(
    'linkedin:send-message',
    (_evt, payload: { profileUrl: string; text: string }) =>
      guard(() => ctx.getDriver().messages.sendMessage(payload.profileUrl, payload.text)),
  );

  ipcMain.handle('linkedin:read-feed', (_evt, payload: { limit?: number }) =>
    guard(() => ctx.getDriver().feed.getFeed(payload?.limit)),
  );

  ipcMain.handle('linkedin:notifications', (_evt, payload: { limit?: number }) =>
    guard(() => ctx.getDriver().feed.getNotifications(payload?.limit)),
  );

  // Today's mutating-action usage vs the daily safety caps.
  ipcMain.handle('linkedin:quota', () => guard(() => getQuotaManager().snapshot()));

  // -- MCP status + catalog (read-only) ------------------------------------

  ipcMain.handle('mcp:status', () => guard(() => ctx.getMcpStatus()));

  // The advertised tool catalog (name + description + input schema), so the
  // renderer can show what this MCP server exposes without re-declaring it.
  ipcMain.handle('mcp:tools', () =>
    guard(() =>
      TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        params: Object.keys(
          (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        ),
      })),
    ),
  );

  // The Claude Desktop config snippet a user pastes to connect this server.
  ipcMain.handle('mcp:config', () =>
    guard(() => buildClaudeDesktopConfig(app.getAppPath())),
  );
}

export function unregisterIpcHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
