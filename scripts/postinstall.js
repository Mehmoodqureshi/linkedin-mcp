#!/usr/bin/env node
/**
 * Cross-context postinstall.
 *
 * Two consumers run this:
 *   1. End users installing via `npx @mehmoodqureshi/linkedin-mcp` (or `npm i -g`).
 *      They have `playwright` (a dependency) but NOT `electron-builder`
 *      (a devDependency).
 *   2. Developers cloning the repo and running `npm install`. They additionally
 *      have `electron-builder` and may build the desktop app.
 *
 * No browser download. The driver is CONNECT-ONLY: it attaches to the desktop
 * app's Electron Chromium over CDP (`chromium.connectOverCDP`) and never launches
 * a Playwright-managed browser, so Playwright's ~120MB Chromium binary is not
 * needed by anyone. (The desktop app renders LinkedIn in Electron's OWN bundled
 * Chromium.) This removes the single biggest install-time cost + failure mode.
 *
 * Goals:
 *   - Only run `electron-builder install-app-deps` when electron-builder is
 *     actually present (dev context); skip it silently otherwise.
 *   - Never hard-fail the install.
 */

'use strict';

const { execFileSync } = require('node:child_process');

function has(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
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

installAppDeps();
