#!/usr/bin/env node
/**
 * pack-mcpb.js — build a `.mcpb` bundle WITHOUT the `@anthropic-ai/mcpb` CLI.
 *
 * A `.mcpb` (Desktop Extension) is just a ZIP archive with `manifest.json` at
 * its root, the server's compiled code, its runtime `node_modules`, and any
 * assets the manifest references. This script assembles exactly that using only
 * Node + the system `zip` (posix) / `tar` (Windows bsdtar) — no extra tooling.
 *
 * Steps:
 *   1. `npm run build` — compile dist/.
 *   2. Stage into a temp dir: manifest.json, dist/, assets/, resources/,
 *      package.json + package-lock.json.
 *   3. `npm ci --omit=dev` in the stage so ONLY runtime deps land in the bundle
 *      (Chromium download is skipped — the driver is connect-only).
 *   4. Zip the stage into ./linkedin-mcp.mcpb.
 *
 * Output: ./linkedin-mcp.mcpb — double-clickable into Claude Desktop.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'linkedin-mcp.mcpb');

function log(msg) {
  process.stderr.write(`[pack-mcpb] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/** Copy a file or directory tree into the stage. */
function copyInto(stage, relPath, { optional = false } = {}) {
  const src = path.join(ROOT, relPath);
  if (!fs.existsSync(src)) {
    if (optional) return;
    throw new Error(`required path missing: ${relPath}`);
  }
  fs.cpSync(src, path.join(stage, relPath), { recursive: true });
}

function main() {
  // 1. Compile.
  log('building dist/…');
  run('npm', ['run', 'build'], { cwd: ROOT, shell: process.platform === 'win32' });

  // 2. Stage.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-mcpb-'));
  log(`staging in ${stage}`);
  for (const p of ['manifest.json', 'package.json', 'package-lock.json', 'dist', 'assets', 'resources', 'README.md']) {
    copyInto(stage, p, { optional: p === 'resources' || p === 'README.md' });
  }

  // 3. Production-only deps (no Chromium — connect-only never launches a browser).
  //    --ignore-scripts: the bundle needs no postinstall (that step is dev-only,
  //    and its script isn't staged); skipping it is also faster and safer.
  log('installing runtime dependencies (production only)…');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stage,
    shell: process.platform === 'win32',
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  // A stray package-lock in the bundle is harmless but pointless — drop it.
  fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });

  // 4. Zip the stage contents (manifest.json must be at the archive ROOT).
  fs.rmSync(OUT, { force: true });
  log(`packing → ${path.relative(ROOT, OUT)}`);
  if (process.platform === 'win32') {
    // bsdtar ships with Windows 10+ and writes real zips.
    run('tar', ['-a', '-c', '-f', OUT, '-C', stage, '.']);
  } else {
    run('zip', ['-r', '-q', OUT, '.'], { cwd: stage });
  }

  fs.rmSync(stage, { recursive: true, force: true });
  const sizeMb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(1);
  log(`done: ${path.relative(ROOT, OUT)} (${sizeMb} MB)`);
  log('Install it by double-clicking the file in Claude Desktop.');
}

main();
