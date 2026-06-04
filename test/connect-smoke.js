/**
 * Connect-handshake smoke test (run under Electron).
 *
 * Guards the load-bearing assumption of the in-app browser: Playwright's
 * `connectOverCDP` must attach to a docked Electron BrowserView and drive it.
 * It also pins the subtle failure mode we hit during development — the handshake
 * HANGS if the host window has no content loaded — by loading the host window
 * first (exactly as the real app does) and asserting the attach succeeds fast.
 *
 * Run:  npm run test:smoke      (xvfb-run on headless CI)
 * Exits 0 on success, 1 on any failed assertion / timeout.
 */
'use strict';

const PORT = 49500 + Math.floor(Math.random() * 1000);
const { app, BrowserWindow, BrowserView } = require('electron');

app.commandLine.appendSwitch('remote-debugging-port', String(PORT));
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const { chromium } = require('playwright');

const checks = [];
const log = (...a) => process.stdout.write('[smoke] ' + a.join(' ') + '\n');
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`);
}
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out (${ms}ms)`)), ms)),
  ]);

async function run() {
  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  // Host window MUST have content before connecting (see module comment).
  await win.loadURL('data:text/html,<title>smoke host</title>');

  const view = new BrowserView({ webPreferences: { partition: 'persist:smoke' } });
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  await view.webContents.loadURL('https://example.com/');

  let browser;
  try {
    browser = await withTimeout(chromium.connectOverCDP(`http://127.0.0.1:${PORT}`), 10000, 'connectOverCDP');
    check('connectOverCDP attaches to Electron', true);
  } catch (err) {
    check('connectOverCDP attaches to Electron', false, err.message);
    return;
  }

  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => host(p.url()) === 'example.com');
  check('Playwright sees the BrowserView page', !!page);
  if (!page) return;

  await page.goto('https://example.org/', { waitUntil: 'domcontentloaded' });
  check('Playwright drives the SAME native view', host(view.webContents.getURL()) === 'example.org');

  const text = await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => null);
  check('locator query works on the driven page', typeof text === 'string' && text.length > 0);

  await browser.close().catch(() => {});
}

app.whenReady().then(async () => {
  const bail = setTimeout(() => {
    log('TIMEOUT');
    app.exit(1);
  }, 30000);
  try {
    await run();
  } catch (err) {
    log('UNCAUGHT: ' + (err && err.stack ? err.stack : String(err)));
  } finally {
    clearTimeout(bail);
    const passed = checks.filter((c) => c.ok).length;
    log(`\n${passed}/${checks.length} checks passed`);
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    app.exit(ok ? 0 : 1);
  }
});
app.on('window-all-closed', () => {});
