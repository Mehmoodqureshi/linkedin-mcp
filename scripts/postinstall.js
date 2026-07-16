#!/usr/bin/env node
/**
 * Cross-context postinstall.
 *
 * Two consumers run this:
 *   1. End users installing via `npx @algorismus/linkedin-mcp` (or `npm i -g`).
 *      They have `playwright` (a dependency) but NOT `electron-builder`
 *      (a devDependency). They need the Chromium browser downloaded.
 *   2. Developers cloning the repo and running `npm install`. They additionally
 *      have `electron-builder` and may build the desktop app.
 *
 * Goals:
 *   - Always make sure Playwright's Chromium is available (the driver needs it).
 *   - Only run `electron-builder install-app-deps` when electron-builder is
 *     actually present (dev context); skip it silently otherwise.
 *   - Never hard-fail the install: a browser-download failure degrades to a
 *     clear warning so `npm install` still succeeds; the user can re-run
 *     `npx playwright install chromium` later.
 *   - Respect skip flags for CI / sandboxed environments.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { dirname, join } = require('node:path');

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

/**
 * Absolute path to Playwright's CLI entrypoint.
 *
 * Resolved via `package.json` + join rather than `require.resolve('playwright/cli')`:
 * Playwright's `exports` map has no `./cli` subpath, so the latter throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED on every platform. `cli.js` is the package's own
 * `bin` target, so its location is stable.
 */
function playwrightCli() {
  return join(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

function has(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function skipBrowserDownload() {
  return (
    process.env.LINKEDIN_MCP_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === 'true'
  );
}

function installChromium() {
  if (skipBrowserDownload()) {
    process.stderr.write('[postinstall] Skipping Chromium download (skip flag set).\n');
    return;
  }
  try {
    // Invoke the CLI through node itself. Going via the `playwright` bin shim
    // would fail on Windows, where it is `playwright.cmd` and execFileSync
    // cannot spawn a .cmd without a shell.
    run(process.execPath, [playwrightCli(), 'install', 'chromium']);
  } catch (err) {
    process.stderr.write(
      '[postinstall] WARNING: could not download Chromium automatically: ' +
        String(err && err.message ? err.message : err) +
        '\n[postinstall] Run `npx playwright install chromium` before first use.\n',
    );
  }
}

function installAppDeps() {
  // Dev-only: rebuild native deps for Electron. No-op for npx consumers since
  // electron-builder is a devDependency they never install.
  if (!has('electron-builder')) return;
  try {
    // shell:true so the electron-builder.cmd shim is spawnable on Windows.
    execFileSync('electron-builder', ['install-app-deps'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    process.stderr.write(
      '[postinstall] electron-builder install-app-deps failed (non-fatal): ' +
        String(err && err.message ? err.message : err) +
        '\n',
    );
  }
}

installChromium();
installAppDeps();
