## 0.6.0 - 2026-07-28

- BREAKING: dropped the Electron desktop app. The MCP server is now standalone and drives your INSTALLED Google Chrome directly (Playwright `channel: 'chrome'`) — no separate app to install/sign/notarize, and no browser download.
- On the first LinkedIn action a visible Chrome window opens for a one-time login; the session persists under `~/.linkedin-mcp`.
- Removed src/main, src/preload, src/renderer, electron-builder config, and the app build/release scripts; the repo is now a pure MCP server. Requires Google Chrome installed.

## 0.5.2 - 2026-07-28

- fix: Windows app auto-launch — probe the NSIS install location (%LOCALAPPDATA%\Programs\LinkedIn MCP\LinkedIn MCP.exe) and the Start Menu shortcut instead of a bare app name that never resolved.
- ci: add a Release workflow (release.yml) that builds the macOS .dmg and Windows .exe installers on their native runners and packs the .mcpb, attaching all three to the GitHub Release for a pushed v* tag.

## 0.5.1 - 2026-07-28

- chore: depend on playwright-core instead of playwright — the driver only uses connectOverCDP, so no browser binary is ever needed. Fully removes the Chromium download from install (smaller, faster, airtight "no download").

## 0.5.0 - 2026-07-28

- refactor: connect-only driver — the MCP server attaches to the desktop app's browser over CDP and never launches its own Chromium; launch/headless mode removed. No more Playwright Chromium download.
- feat: standalone/npx servers auto-discover a running app (and launch one if none is running) instead of failing — the app advertises its CDP endpoint.
- feat: add linkedin_update_profile tool to edit your own profile (headline, about, first/last name, location); gated behind LINKEDIN_ALLOW_MUTATIONS.
- feat: one-click install for Claude Desktop via a .mcpb bundle (manifest.json) with a CLI-free packer (npm run pack:mcpb); write actions surfaced as a config toggle.

## 0.4.9 - 2026-07-17

- feat: add linkedin_get_messages tool to read a conversation thread

## 0.4.7 - 2026-07-14

- feat: report resetsAt (next local-midnight rollover) in the linkedin_get_quota tool

## 0.4.6 - 2026-07-13

- feat: add linkedin_get_quota MCP tool to report daily action-cap usage

