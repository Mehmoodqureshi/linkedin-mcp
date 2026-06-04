/**
 * Renderer for the LinkedIn MCP control panel + embedded browser.
 *
 * Left rail: live status pills, a NAVIGATION rail that steers the embedded
 * browser (Feed / Network / Jobs / …), session controls, the MCP tool catalog,
 * the Claude Desktop connect snippet, and an activity log.
 *
 * Right pane: a NATIVE Electron BrowserView (the real LinkedIn page) docked over
 * the `#stage` placeholder by the main process. The renderer never paints the
 * page itself — it only measures the stage rectangle and reports it via
 * `browser:bounds` so main can keep the view matched to the pane. The user
 * interacts with the view directly (real scroll/click/type); the toolbar +
 * nav-rail drive it through `browser:*` commands.
 *
 * This file is intentionally a CLASSIC script (no top-level import/export) so it
 * runs over file:// in the Electron renderer.
 */

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

interface ToolInfo {
  name: string;
  description: string;
  params: string[];
}

/** A people-search result card (subset of the driver's SearchResult). */
interface PersonResult {
  name?: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  connectionDegree?: string;
}

/** A job-search result card (subset of the driver's JobResult). */
interface JobResult {
  title?: string;
  company?: string;
  location?: string;
  jobUrl?: string;
  postedDate?: string;
  easyApply?: boolean;
}

/** Today's usage vs cap for one mutating action. */
interface QuotaRow {
  action: string;
  used: number;
  cap: number;
}

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

type InvokeChannel =
  | 'driver:start'
  | 'driver:stop'
  | 'driver:status'
  | 'linkedin:logout'
  | 'linkedin:search-people'
  | 'linkedin:search-jobs'
  | 'linkedin:send-connection'
  | 'linkedin:quota'
  | 'mcp:status'
  | 'mcp:tools'
  | 'mcp:config'
  | 'browser:attach'
  | 'browser:detach'
  | 'browser:navigate'
  | 'browser:back'
  | 'browser:forward'
  | 'browser:reload'
  | 'browser:login'
  | 'browser:bounds';

type EventChannel =
  | 'driver:status-changed'
  | 'mcp:status-changed'
  | 'action:log'
  | 'browser:url'
  | 'browser:loading';

interface LinkedinMcpBridge {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  refreshTray(): void;
}

interface Window {
  linkedinMCP: LinkedinMcpBridge;
}

type LogLevel = 'info' | 'success' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

const pillAuth = el<HTMLSpanElement>('pill-auth');
const pillAuthDot = el<HTMLSpanElement>('pill-auth-dot');
const pillMcp = el<HTMLSpanElement>('pill-mcp');
const pillMcpDot = el<HTMLSpanElement>('pill-mcp-dot');

const infoServer = el<HTMLDivElement>('info-server');
const infoTransport = el<HTMLDivElement>('info-transport');
const infoClients = el<HTMLDivElement>('info-clients');
const infoBrowser = el<HTMLDivElement>('info-browser');

const btnLogin = el<HTMLButtonElement>('btn-login');
const btnLogout = el<HTMLButtonElement>('btn-logout');
const btnRestart = el<HTMLButtonElement>('btn-restart');
const btnCopy = el<HTMLButtonElement>('btn-copy');
const btnClear = el<HTMLButtonElement>('btn-clear');

const configSnippet = el<HTMLPreElement>('config-snippet');
const toolList = el<HTMLDivElement>('tool-list');
const toolCount = el<HTMLSpanElement>('tool-count');
const toolFilter = el<HTMLInputElement>('tool-filter');
const logEl = el<HTMLPreElement>('log');

const btnHamburger = el<HTMLButtonElement>('btn-hamburger');
const btnCollapse = el<HTMLButtonElement>('btn-collapse');
const appEl = document.querySelector<HTMLDivElement>('.app');
const navBack = el<HTMLButtonElement>('nav-back');
const navForward = el<HTMLButtonElement>('nav-forward');
const navReload = el<HTMLButtonElement>('nav-reload');
const urlBar = el<HTMLInputElement>('url-bar');

const stage = el<HTMLDivElement>('stage');
const overlay = el<HTMLDivElement>('overlay');
const overlayText = el<HTMLDivElement>('overlay-text');

const navItems = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.nav-item'),
);

// Search controls
const searchQuery = el<HTMLInputElement>('search-query');
const searchLocation = el<HTMLInputElement>('search-location');
const btnSearch = el<HTMLButtonElement>('btn-search');
const btnExport = el<HTMLButtonElement>('btn-export');
const searchResults = el<HTMLDivElement>('search-results');
const segItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg-item'));
const filtersPeople = el<HTMLDivElement>('filters-people');
const filtersJobs = el<HTMLDivElement>('filters-jobs');
// People filters
const fTitle = el<HTMLInputElement>('f-title');
const fCompany = el<HTMLInputElement>('f-company');
const fDegree = el<HTMLSelectElement>('f-degree');
// Job filters
const fDate = el<HTMLSelectElement>('f-date');
const fExp = el<HTMLSelectElement>('f-exp');
const fRemote = el<HTMLInputElement>('f-remote');
const fEasy = el<HTMLInputElement>('f-easy');
// Daily limits
const quotaList = el<HTMLDivElement>('quota-list');

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 400;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES && logEl.firstElementChild) {
    logEl.removeChild(logEl.firstElementChild);
  }
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// IPC helpers
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
    const err = new Error(result.error.message) as Error & { code: string };
    err.code = result.error.code;
    throw err;
  }
  return result.data;
}

async function browserCmd(channel: InvokeChannel, payload?: unknown): Promise<void> {
  try {
    await window.linkedinMCP.invoke(channel, ...(payload === undefined ? [] : [payload]));
  } catch (err) {
    log(`Browser command ${channel} failed: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderDriver(status: DriverStatus): void {
  // Auth pill
  pillAuthDot.classList.remove('ok', 'warn');
  if (status.isLoggedIn) {
    pillAuthDot.classList.add('ok');
    pillAuth.textContent = 'signed in';
  } else if (status.status === 'launching') {
    pillAuthDot.classList.add('warn');
    pillAuth.textContent = 'launching…';
  } else {
    pillAuth.textContent = 'signed out';
  }

  const running = status.status === 'ready' || status.status === 'launching';
  infoBrowser.textContent = running ? 'running' : 'stopped';
  infoBrowser.className = `v ${running ? 'good' : 'bad'}`;

  btnLogout.disabled = !status.isLoggedIn;
}

function renderMcp(mcp: McpStatusSnapshot): void {
  pillMcpDot.classList.toggle('ok', mcp.running);
  pillMcp.textContent = mcp.running
    ? `MCP · ${mcp.connectedClients} client${mcp.connectedClients === 1 ? '' : 's'}`
    : 'MCP offline';

  infoServer.textContent = mcp.running ? 'running' : 'stopped';
  infoServer.className = `v ${mcp.running ? 'good' : 'bad'}`;
  infoTransport.textContent = mcp.running ? mcp.transport : 'offline';
  infoClients.textContent = String(mcp.connectedClients);
  infoClients.className = `v ${mcp.connectedClients > 0 ? 'good' : ''}`;
}

let allTools: ToolInfo[] = [];

function renderTools(): void {
  const q = toolFilter.value.trim().toLowerCase();
  const tools = q
    ? allTools.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      )
    : allTools;

  toolCount.textContent = String(allTools.length);
  toolList.replaceChildren();
  for (const t of tools) {
    const row = document.createElement('div');
    row.className = 'tool';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.name;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = t.description;
    row.append(name, desc);
    toolList.appendChild(row);
  }
}

toolFilter.addEventListener('input', renderTools);

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;
let polling = false;

async function pollStatus(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const [driver, mcp, quota] = await Promise.all([
      call<DriverStatus>('driver:status').catch(() => null),
      call<McpStatusSnapshot>('mcp:status').catch(() => null),
      call<QuotaRow[]>('linkedin:quota').catch(() => null),
    ]);
    if (driver) renderDriver(driver);
    if (mcp) renderMcp(mcp);
    if (quota) renderQuota(quota);
  } finally {
    polling = false;
  }
}

/** Render today's per-action usage as labelled progress bars. */
function renderQuota(rows: QuotaRow[]): void {
  quotaList.replaceChildren(
    ...rows.map((r) => {
      const pct = r.cap > 0 ? Math.min(100, Math.round((r.used / r.cap) * 100)) : 0;
      const row = document.createElement('div');
      row.className = 'quota-row';

      const head = document.createElement('div');
      head.className = 'qr-head';
      const name = document.createElement('span');
      name.textContent = r.action.charAt(0).toUpperCase() + r.action.slice(1) + 's';
      const val = document.createElement('span');
      val.className = 'qr-val';
      val.textContent = `${r.used}/${r.cap}`;
      head.append(name, val);

      const track = document.createElement('div');
      track.className = 'qr-track';
      const fill = document.createElement('div');
      fill.className = `qr-fill${pct >= 100 ? ' full' : pct >= 80 ? ' warn' : ''}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);

      row.append(head, track);
      return row;
    }),
  );
}

async function loadCatalog(): Promise<void> {
  try {
    allTools = await call<ToolInfo[]>('mcp:tools');
    renderTools();
  } catch (err) {
    log(`Failed to load tool catalog: ${(err as Error).message}`, 'warn');
  }
  try {
    configSnippet.textContent = JSON.stringify(await call<unknown>('mcp:config'), null, 2);
  } catch (err) {
    configSnippet.textContent = '// failed to build config snippet';
    log(`Failed to load config snippet: ${(err as Error).message}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Navigation rail (drives the embedded browser)
// ---------------------------------------------------------------------------

function setActiveNav(url: string): void {
  for (const item of navItems) {
    const target = item.dataset.url ?? '';
    item.classList.toggle('active', !!target && url.startsWith(target));
  }
}

for (const item of navItems) {
  item.addEventListener('click', () => {
    const url = item.dataset.url;
    if (!url) return;
    void browserCmd('browser:navigate', url);
  });
}

// ---------------------------------------------------------------------------
// Search (People / Jobs) — drives the embedded view AND lists structured cards
// ---------------------------------------------------------------------------
// A search runs the driver's URL-built + scrape pipeline on the shared page, so
// the native pane navigates to the LinkedIn results while we render clickable
// cards here. Clicking a card opens that profile/job in the pane.

type SearchMode = 'people' | 'jobs';
let searchMode: SearchMode = 'people';

/** Last result set, retained so "Export CSV" can serialize exactly what's shown. */
let lastPeople: PersonResult[] = [];
let lastJobs: JobResult[] = [];

for (const seg of segItems) {
  seg.addEventListener('click', () => {
    const mode = (seg.dataset.mode as SearchMode) ?? 'people';
    if (mode === searchMode) return;
    searchMode = mode;
    for (const s of segItems) s.classList.toggle('active', s === seg);
    searchQuery.placeholder = mode === 'people' ? 'Search people…' : 'Search jobs…';
    searchLocation.hidden = mode !== 'jobs';
    filtersPeople.hidden = mode !== 'people';
    filtersJobs.hidden = mode !== 'jobs';
    searchResults.replaceChildren();
    btnExport.disabled = true;
  });
}

btnSearch.addEventListener('click', () => void runSearch());
btnExport.addEventListener('click', exportCsv);
searchQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void runSearch();
});
for (const f of [searchLocation, fTitle, fCompany]) {
  f.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch();
  });
}

/** Gather the active people filters into the driver's PeopleFilters shape. */
function peopleFilters(): Record<string, string> {
  const f: Record<string, string> = {};
  if (fTitle.value.trim()) f.title = fTitle.value.trim();
  if (fCompany.value.trim()) f.company = fCompany.value.trim();
  if (fDegree.value) f.connectionDegree = fDegree.value;
  return f;
}

/** Gather the active job filters into the driver's JobFilters shape. */
function jobFilters(): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  if (searchLocation.value.trim()) f.location = searchLocation.value.trim();
  if (fDate.value) f.datePosted = fDate.value;
  if (fExp.value) f.experienceLevel = fExp.value;
  if (fRemote.checked) f.remote = true;
  if (fEasy.checked) f.easyApply = true;
  return f;
}

async function runSearch(): Promise<void> {
  const query = searchQuery.value.trim();
  if (!query) {
    searchQuery.focus();
    return;
  }
  await withButton(btnSearch, async () => {
    btnSearch.textContent = 'Searching…';
    btnExport.disabled = true;
    searchResults.replaceChildren(emptyRow('Searching LinkedIn…'));
    try {
      if (searchMode === 'people') {
        const filters = peopleFilters();
        const people = await call<PersonResult[]>('linkedin:search-people', {
          query,
          ...(Object.keys(filters).length ? { filters } : {}),
        });
        lastPeople = people;
        renderPeople(people);
        btnExport.disabled = people.length === 0;
        log(`Found ${people.length} ${people.length === 1 ? 'person' : 'people'} for “${query}”.`, 'success');
      } else {
        const filters = jobFilters();
        const jobs = await call<JobResult[]>('linkedin:search-jobs', {
          query,
          ...(Object.keys(filters).length ? { filters } : {}),
        });
        lastJobs = jobs;
        renderJobs(jobs);
        btnExport.disabled = jobs.length === 0;
        log(`Found ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} for “${query}”.`, 'success');
      }
    } catch (err) {
      searchResults.replaceChildren(emptyRow(classifySearchError(err as Error & { code?: string })));
    } finally {
      btnSearch.textContent = 'Search';
    }
  });
}

/** Turn a driver error code into a clear, actionable message (+ log line). */
function classifySearchError(e: Error & { code?: string }): string {
  switch (e.code) {
    case 'needs_login':
      log('Search needs an authenticated session. Sign in via the pane.', 'warn');
      return 'Sign in first — then search again.';
    case 'needs_verification':
      log('LinkedIn checkpoint — solve the challenge in the pane, then retry.', 'warn');
      return '⚠ Verify in the pane (LinkedIn security check), then search again.';
    case 'quota_exceeded':
      log(e.message, 'warn');
      return e.message;
    default:
      log(`Search failed: ${e.message}`, 'error');
      return `Search failed: ${e.message}`;
  }
}

function emptyRow(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'res-empty';
  d.textContent = text;
  return d;
}

/**
 * A result card: a clickable header that opens `url` in the embedded pane, plus
 * an optional row of action buttons (e.g. Connect for people).
 */
function resultCard(
  title: string,
  sub: string,
  meta: string[],
  url: string | undefined,
  actions: Array<{ label: string; primary?: boolean; run: (btn: HTMLButtonElement) => void }> = [],
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'res-card';

  const header = document.createElement('div');
  if (url) {
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => void browserCmd('browser:navigate', url));
  }

  const t = document.createElement('div');
  t.className = 'rc-title';
  t.textContent = title;
  header.appendChild(t);

  if (sub) {
    const s = document.createElement('div');
    s.className = 'rc-sub';
    s.textContent = sub;
    header.appendChild(s);
  }

  const tags = meta.filter(Boolean);
  if (tags.length) {
    const m = document.createElement('div');
    m.className = 'rc-meta';
    for (const text of tags) {
      const tag = document.createElement('span');
      tag.className = 'res-tag';
      tag.textContent = text;
      m.appendChild(tag);
    }
    header.appendChild(m);
  }
  card.appendChild(header);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'rc-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `rc-btn${a.primary ? ' primary' : ''}`;
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => a.run(b));
      row.appendChild(b);
    }
    card.appendChild(row);
  }
  return card;
}

function renderPeople(people: PersonResult[]): void {
  if (!people.length) {
    searchResults.replaceChildren(emptyRow('No people found.'));
    return;
  }
  searchResults.replaceChildren(
    ...people.map((p) =>
      resultCard(
        p.name || '(unknown)',
        p.headline || '',
        [p.location ?? '', p.connectionDegree ?? ''],
        p.profileUrl,
        p.profileUrl
          ? [
              { label: 'Open', run: () => void browserCmd('browser:navigate', p.profileUrl as string) },
              { label: 'Connect', primary: true, run: (b) => void connectTo(p.profileUrl as string, b) },
            ]
          : [],
      ),
    ),
  );
}

function renderJobs(jobs: JobResult[]): void {
  if (!jobs.length) {
    searchResults.replaceChildren(emptyRow('No jobs found.'));
    return;
  }
  searchResults.replaceChildren(
    ...jobs.map((j) =>
      resultCard(
        j.title || '(untitled role)',
        [j.company, j.location].filter(Boolean).join(' · '),
        [j.postedDate ?? '', j.easyApply ? 'Easy Apply' : ''],
        j.jobUrl,
        j.jobUrl
          ? [{ label: 'Open job', run: () => void browserCmd('browser:navigate', j.jobUrl as string) }]
          : [],
      ),
    ),
  );
}

/** Send a connection request from a result card, reflecting the outcome inline. */
async function connectTo(profileUrl: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const res = await call<{ success: boolean; outcome?: string; message: string }>(
      'linkedin:send-connection',
      { profileUrl },
    );
    btn.textContent = res.success ? 'Sent ✓' : (res.outcome ?? 'Done');
    log(res.message, res.success ? 'success' : 'warn');
  } catch (err) {
    const e = err as Error & { code?: string };
    btn.disabled = false;
    btn.textContent = prev;
    log(classifySearchError(e), e.code === 'quota_exceeded' ? 'warn' : 'error');
  }
}

/** Export the current result set to a CSV file the user can save. */
function exportCsv(): void {
  const isPeople = searchMode === 'people';
  const headers = isPeople
    ? ['name', 'headline', 'location', 'connectionDegree', 'profileUrl']
    : ['title', 'company', 'location', 'postedDate', 'easyApply', 'jobUrl'];
  const rows: string[][] = isPeople
    ? lastPeople.map((p) => [p.name, p.headline, p.location, p.connectionDegree, p.profileUrl].map(cell))
    : lastJobs.map((j) =>
        [j.title, j.company, j.location, j.postedDate, j.easyApply ? 'yes' : 'no', j.jobUrl].map(cell),
      );
  if (!rows.length) return;

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkedin-${searchMode}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  log(`Exported ${rows.length} ${searchMode} to CSV.`, 'success');
}

/** CSV-escape a single cell. */
function cell(v: string | undefined): string {
  const s = (v ?? '').replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// ---------------------------------------------------------------------------
// Session controls
// ---------------------------------------------------------------------------

async function withButton(btn: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  const prev = btn.disabled;
  btn.disabled = true;
  try {
    await action();
  } finally {
    btn.disabled = prev;
  }
}

btnLogin.addEventListener('click', () =>
  withButton(btnLogin, async () => {
    log('Opening LinkedIn sign-in…');
    await browserCmd('browser:login');
  }),
);

btnLogout.addEventListener('click', () =>
  withButton(btnLogout, async () => {
    log('Logging out…');
    try {
      await call('linkedin:logout');
      log('Logged out.', 'success');
      await browserCmd('browser:attach');
      await pollStatus();
    } catch (err) {
      log(`Logout failed: ${(err as Error).message}`, 'error');
    }
  }),
);

btnRestart.addEventListener('click', () =>
  withButton(btnRestart, async () => {
    log('Reloading browser…');
    try {
      await browserCmd('browser:reload');
      reportBounds();
      log('Browser reloaded.', 'success');
      await pollStatus();
    } catch (err) {
      log(`Reload failed: ${(err as Error).message}`, 'error');
    }
  }),
);

btnCopy.addEventListener('click', () => {
  void navigator.clipboard
    .writeText(configSnippet.textContent ?? '')
    .then(() => log('Config snippet copied.', 'success'))
    .catch(() => log('Copy failed.', 'warn'));
});

btnClear.addEventListener('click', () => logEl.replaceChildren());

// ---------------------------------------------------------------------------
// Browser toolbar
// ---------------------------------------------------------------------------

// Collapse / expand the sidebar. The « button lives in the sidebar header; the
// ☰ button lives in the toolbar and is only visible while collapsed (so there's
// always a way to bring the sidebar back). The ResizeObserver on the stage picks
// up the width change and re-syncs the page viewport; we also nudge it once the
// collapse animation settles so the browser fills the new width edge-to-edge.
function toggleSidebar(): void {
  appEl?.classList.toggle('collapsed');
  window.setTimeout(reportBounds, 260);
}
btnCollapse.addEventListener('click', toggleSidebar);
btnHamburger.addEventListener('click', toggleSidebar);

navBack.addEventListener('click', () => void browserCmd('browser:back'));
navForward.addEventListener('click', () => void browserCmd('browser:forward'));
navReload.addEventListener('click', () => void browserCmd('browser:reload'));

urlBar.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const url = urlBar.value.trim();
  if (!url) return;
  void browserCmd('browser:navigate', url);
});

// ---------------------------------------------------------------------------
// Bounds reporting — keep the native BrowserView matched to the #stage pane
// ---------------------------------------------------------------------------
// The renderer doesn't paint the page; it measures the stage's rectangle (in
// CSS px, relative to the window content area — which is exactly the
// BrowserView's coordinate space) and reports it so main can dock the view.

let lastBounds = { x: 0, y: 0, w: 0, h: 0 };

function reportBounds(): void {
  const r = stage.getBoundingClientRect();
  const x = Math.round(r.left);
  const y = Math.round(r.top);
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  if (w < 200 || h < 150) return;
  if (
    Math.abs(x - lastBounds.x) < 2 &&
    Math.abs(y - lastBounds.y) < 2 &&
    Math.abs(w - lastBounds.w) < 2 &&
    Math.abs(h - lastBounds.h) < 2
  ) {
    return;
  }
  lastBounds = { x, y, w, h };
  void browserCmd('browser:bounds', { x, y, width: w, height: h });
}

let resizeTimer = 0;
const ro = new ResizeObserver(() => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(reportBounds, 130);
});
ro.observe(stage);
// The stage rect also shifts on window resize/move without the stage element
// itself resizing, so re-report on those too.
window.addEventListener('resize', reportBounds);

// ---------------------------------------------------------------------------
// Embedded-browser chrome (URL bar + load spinner)
// ---------------------------------------------------------------------------

function showOverlay(text: string): void {
  overlayText.textContent = text;
  overlay.classList.remove('hidden');
}
function hideOverlay(): void {
  overlay.classList.add('hidden');
}

let checkpointFlagged = false;

window.linkedinMCP.on('browser:url', (payload) => {
  const u = payload as { url?: string };
  if (u && typeof u.url === 'string') {
    if (document.activeElement !== urlBar) urlBar.value = u.url;
    setActiveNav(u.url);
    // First real URL means the native view is up and covering the stage; the
    // "starting" overlay (which sits BEHIND the view) is no longer needed.
    hideOverlay();

    // Surface a LinkedIn security checkpoint once: the page is interactive in
    // the pane, so the user can solve it there directly.
    const isCheckpoint = /\/checkpoint\/|\/challenge\//.test(u.url);
    if (isCheckpoint && !checkpointFlagged) {
      checkpointFlagged = true;
      log('⚠ LinkedIn security checkpoint — complete it in the pane, then continue.', 'warn');
    } else if (!isCheckpoint) {
      checkpointFlagged = false;
    }
  }
});

window.linkedinMCP.on('browser:loading', (payload) => {
  const l = payload as { loading?: boolean };
  navReload.classList.toggle('loading', !!l?.loading);
});

// ---------------------------------------------------------------------------
// Push events from main
// ---------------------------------------------------------------------------

window.linkedinMCP.on('driver:status-changed', (payload) => {
  const s = payload as DriverStatus | null;
  if (s && typeof s === 'object' && 'status' in s) renderDriver(s);
  else void pollStatus();
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
      p.level === 'success' || p.level === 'warn' || p.level === 'error' ? p.level : 'info';
    log(p.message, level);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function boot(): void {
  log('Control panel ready.', 'success');
  showOverlay('Starting browser…');
  void pollStatus();
  void loadCatalog();
  // Report the pane rect first so the docked view is sized correctly, then ask
  // main to ensure the view is attached.
  reportBounds();
  void browserCmd('browser:attach');
  window.setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
