/**
 * Renderer process script for the LinkedIn MCP Driver control panel.
 *
 * Runs in a sandboxed, context-isolated renderer with NO Node access. All
 * communication with the main process flows through the frozen bridge exposed
 * by the preload script on `window.linkedinMCP`:
 *
 *   - `invoke(channel, ...args)` -> Promise<IpcResult>  (request/response)
 *   - `on(channel, listener)`    -> unsubscribe          (push events)
 *
 * This module:
 *   - Polls `driver:status` + `mcp:status` every 3s and repaints the UI.
 *   - Wires Start / Stop / Login / Logout controls to their IPC channels.
 *   - Subscribes to `driver:status-changed` and `action:log` push events.
 *   - Shows/hides the login form based on whether the session is valid.
 */

// ---------------------------------------------------------------------------
// Mirrored IPC types (kept local so the renderer needs no main-process import).
// ---------------------------------------------------------------------------

type DriverState = 'idle' | 'launching' | 'ready' | 'error' | 'closed';

interface DriverStatus {
  status: DriverState;
  isLoggedIn: boolean;
  sessionValid: boolean;
}

interface McpStatusSnapshot {
  running: boolean;
  transport: string;
  connectedClients: number;
}

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

type InvokeChannel =
  | 'driver:start'
  | 'driver:stop'
  | 'driver:status'
  | 'linkedin:login'
  | 'linkedin:logout'
  | 'mcp:status';

type EventChannel = 'driver:status-changed' | 'mcp:status-changed' | 'action:log';

interface LinkedinMcpBridge {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  refreshTray(): void;
}

declare global {
  interface Window {
    linkedinMCP: LinkedinMcpBridge;
  }
}

type LogLevel = 'info' | 'success' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// DOM lookups
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

const statusDot = el<HTMLSpanElement>('status-dot');
const statusText = el<HTMLSpanElement>('status-text');

const btnStart = el<HTMLButtonElement>('btn-start');
const btnStop = el<HTMLButtonElement>('btn-stop');
const btnLogin = el<HTMLButtonElement>('btn-login');
const btnLogout = el<HTMLButtonElement>('btn-logout');
const btnClear = el<HTMLButtonElement>('btn-clear');

const loginPanel = el<HTMLElement>('login-panel');
const loginForm = el<HTMLFormElement>('login-form');
const emailInput = el<HTMLInputElement>('email');
const passwordInput = el<HTMLInputElement>('password');

const infoState = el<HTMLDivElement>('info-state');
const infoSession = el<HTMLDivElement>('info-session');
const infoClients = el<HTMLDivElement>('info-clients');
const infoTransport = el<HTMLDivElement>('info-transport');

const logEl = el<HTMLPreElement>('log');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 500;

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(message: string, level: LogLevel = 'info'): void {
  const line = document.createElement('span');
  line.className = `log-line ${level}`;

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = `[${timestamp()}] `;

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = message;

  line.append(ts, msg, document.createTextNode('\n'));

  const wasAtBottom =
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;

  logEl.appendChild(line);

  while (logEl.childElementCount > MAX_LOG_LINES && logEl.firstElementChild) {
    logEl.removeChild(logEl.firstElementChild);
  }

  if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// IPC helper — unwraps the { ok, data | error } envelope.
// ---------------------------------------------------------------------------

async function call<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  const raw =
    payload === undefined
      ? await window.linkedinMCP.invoke(channel)
      : await window.linkedinMCP.invoke(channel, payload);

  const result = raw as IpcResult<T>;
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`Malformed IPC response from ${channel}`);
  }
  if (!result.ok) {
    const { code, message } = result.error;
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    throw err;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

/** Maps the driver lifecycle state onto a status dot color + label. */
function paintStatusDot(state: DriverState, loggedIn: boolean): void {
  statusDot.classList.remove('ready', 'launching', 'error');

  if (state === 'launching') {
    statusDot.classList.add('launching');
    statusText.textContent = 'launching…';
  } else if (state === 'ready') {
    statusDot.classList.add('ready');
    statusText.textContent = loggedIn ? 'ready · signed in' : 'ready · signed out';
  } else if (state === 'error') {
    statusDot.classList.add('error');
    statusText.textContent = 'error';
  } else {
    // idle | closed
    statusDot.classList.add('error');
    statusText.textContent = state === 'closed' ? 'stopped' : 'idle';
  }
}

function renderDriver(status: DriverStatus): void {

  paintStatusDot(status.status, status.isLoggedIn);

  const running = status.status === 'ready' || status.status === 'launching';
  btnStart.disabled = running;
  btnStop.disabled = !running;
  btnLogout.disabled = !status.isLoggedIn;

  // The login panel is hidden whenever the session is valid (authenticated or
  // restorable from persisted cookies); otherwise it is shown so the user can
  // enter credentials.
  const sessionUsable = status.isLoggedIn || status.sessionValid;
  loginPanel.classList.toggle('hidden', sessionUsable);

  infoState.textContent = status.status;
  infoState.className = `v ${status.status === 'ready' ? 'good' : status.status === 'error' ? 'bad' : ''}`;

  const sessionLabel = status.isLoggedIn
    ? 'authenticated'
    : status.sessionValid
      ? 'valid'
      : 'none';
  infoSession.textContent = sessionLabel;
  infoSession.className = `v ${status.isLoggedIn || status.sessionValid ? 'good' : 'bad'}`;
}

function renderMcp(mcp: McpStatusSnapshot): void {
  infoClients.textContent = String(mcp.connectedClients);
  infoClients.className = `v ${mcp.connectedClients > 0 ? 'good' : ''}`;
  infoTransport.textContent = mcp.running ? mcp.transport : 'offline';
  infoTransport.className = `v ${mcp.running ? '' : 'bad'}`;
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;
let polling = false;

async function pollStatus(): Promise<void> {
  if (polling) return; // avoid overlap if a poll runs long
  polling = true;
  try {
    const [driver, mcp] = await Promise.all([
      call<DriverStatus>('driver:status').catch(() => null),
      call<McpStatusSnapshot>('mcp:status').catch(() => null),
    ]);
    if (driver) renderDriver(driver);
    if (mcp) renderMcp(mcp);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Control wiring
// ---------------------------------------------------------------------------

async function withButton(
  btn: HTMLButtonElement,
  action: () => Promise<void>,
): Promise<void> {
  const prev = btn.disabled;
  btn.disabled = true;
  try {
    await action();
  } finally {
    btn.disabled = prev;
  }
}

btnStart.addEventListener('click', () =>
  withButton(btnStart, async () => {
    log('Starting driver…');
    try {
      const status = await call<DriverStatus>('driver:start');
      renderDriver(status);
      log('Driver started.', 'success');
    } catch (err) {
      log(`Start failed: ${(err as Error).message}`, 'error');
    }
  }),
);

btnStop.addEventListener('click', () =>
  withButton(btnStop, async () => {
    log('Stopping driver…');
    try {
      const status = await call<DriverStatus>('driver:stop');
      renderDriver(status);
      log('Driver stopped.', 'success');
    } catch (err) {
      log(`Stop failed: ${(err as Error).message}`, 'error');
    }
  }),
);

btnLogout.addEventListener('click', () =>
  withButton(btnLogout, async () => {
    log('Logging out…');
    try {
      await call('linkedin:logout');
      log('Logged out.', 'success');
      await pollStatus();
    } catch (err) {
      log(`Logout failed: ${(err as Error).message}`, 'error');
    }
  }),
);

loginForm.addEventListener('submit', (evt) => {
  evt.preventDefault();
  void withButton(btnLogin, async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      log('Email and password are required.', 'warn');
      return;
    }
    log(`Logging in as ${email}…`);
    try {
      await call('linkedin:login', { email, password });
      passwordInput.value = '';
      log('Login successful.', 'success');
      await pollStatus();
    } catch (err) {
      const e = err as Error & { code?: string };
      log(`Login failed${e.code ? ` (${e.code})` : ''}: ${e.message}`, 'error');
    }
  });
});

btnClear.addEventListener('click', () => {
  logEl.replaceChildren();
});

// ---------------------------------------------------------------------------
// Push-event subscriptions
// ---------------------------------------------------------------------------

window.linkedinMCP.on('driver:status-changed', (payload) => {
  const status = payload as Partial<DriverStatus> & { state?: DriverState };
  // Main may emit a bare state string-ish snapshot; normalize defensively.
  if (status && typeof status === 'object' && 'status' in status) {
    renderDriver(status as DriverStatus);
  } else {
    void pollStatus();
  }
});

window.linkedinMCP.on('mcp:status-changed', (payload) => {
  const mcp = payload as McpStatusSnapshot;
  if (mcp && typeof mcp === 'object' && 'running' in mcp) renderMcp(mcp);
});

window.linkedinMCP.on('action:log', (payload) => {
  if (typeof payload === 'string') {
    log(payload);
    return;
  }
  const p = payload as { level?: LogLevel; message?: string } | null;
  if (p && typeof p === 'object' && typeof p.message === 'string') {
    const level: LogLevel =
      p.level === 'success' || p.level === 'warn' || p.level === 'error'
        ? p.level
        : 'info';
    log(p.message, level);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function boot(): void {
  log('Control panel ready.', 'success');
  void pollStatus();
  window.setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export {};
