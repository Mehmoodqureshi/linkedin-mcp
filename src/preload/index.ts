/**
 * Preload script — the ONLY bridge between the sandboxed renderer and the
 * Electron main process.
 *
 * Runs with:
 *   contextIsolation: true
 *   sandbox: true
 *   nodeIntegration: false
 *
 * So the renderer has no Node access. We expose a single, typed, frozen API
 * surface on `window.linkedinMCP`. The renderer calls `invoke(channel, ...args)`
 * which forwards to `ipcRenderer.invoke`, and subscribes to push events
 * (e.g. driver status changes) via `on(...)`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// ---------------------------------------------------------------------------
// Channel allow-lists
// ---------------------------------------------------------------------------
// We never forward arbitrary channel names from the renderer into main. Only
// the explicitly enumerated channels are permitted, which keeps the IPC
// surface auditable and prevents a compromised renderer from reaching handlers
// it was never meant to touch.

const INVOKE_CHANNELS = [
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
  'mcp:status',
] as const;

const EVENT_CHANNELS = [
  'driver:status-changed',
  'mcp:status-changed',
  'action:log',
] as const;

type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
type EventChannel = (typeof EVENT_CHANNELS)[number];

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

// ---------------------------------------------------------------------------
// Exposed API
// ---------------------------------------------------------------------------

const api = {
  /**
   * Invoke a main-process handler. Rejects if the channel is not allow-listed.
   * The resolved value is the `{ ok, data | error }` envelope from main.
   */
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`Blocked invoke on disallowed channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /**
   * Subscribe to a push event from main. Returns an unsubscribe function.
   */
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!eventSet.has(channel)) {
      throw new Error(`Blocked listener on disallowed channel: ${channel}`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /** Fire-and-forget: ask main to refresh the tray menu state. */
  refreshTray(): void {
    ipcRenderer.send('ui:refresh-tray');
  },
} as const;

export type LinkedinMcpApi = typeof api;

contextBridge.exposeInMainWorld('linkedinMCP', api);

declare global {
  interface Window {
    linkedinMCP: LinkedinMcpApi;
  }
}
