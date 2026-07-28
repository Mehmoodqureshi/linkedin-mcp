# LinkedIn MCP

[![CI](https://github.com/Mehmoodqureshi/linkedin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mehmoodqureshi/linkedin-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40mehmoodqureshi%2Flinkedin-mcp?label=npm)](https://www.npmjs.com/package/@mehmoodqureshi/linkedin-mcp)
[![license](https://img.shields.io/npm/l/%40mehmoodqureshi%2Flinkedin-mcp?label=license)](LICENSE)

A local Electron desktop app that drives **LinkedIn** in a real, visible browser window and exposes that automation to **Claude Desktop** (or any MCP client) as an **MCP server over stdio**.

Instead of using LinkedIn's (restricted) official API, the app logs in as you in a real browser window, keeps the session alive on disk, and lets an AI assistant call a small set of well-defined tools (view a profile, search people/jobs/companies, send a message, send a connection request, read the feed and notifications, update your own profile, etc.). You stay in control: login is manual and headed, so you complete any 2FA/captcha yourself, and your password is never stored.

The MCP server is **connect-only**: it attaches to the desktop app's browser over CDP and never launches a browser of its own. That means **no Playwright Chromium download** — the app renders LinkedIn in Electron's own bundled browser, and the server just drives it.

---

## What it does

- **Headed, persistent browser session.** Renders LinkedIn in the app's own visible Electron browser with an on-disk session, plus a portable `storageState` snapshot for fast validation and recovery. The MCP server attaches to it over CDP (`connectOverCDP`) — it never launches a browser of its own.
- **Control panel UI.** An Electron window shows driver/session status, a sign-in panel, an MCP-client indicator, and a live activity log. The app also lives in the system tray and keeps running in the background as an MCP server.
- **MCP server over stdio.** Exposes LinkedIn actions as MCP tools so Claude Desktop can call them. All diagnostics go to stderr so the JSON-RPC stream on stdout stays clean.
- **Rate-limit-aware automation.** Every state-changing action is paced (>= ~2s with jitter) and selectors prefer ARIA/`data-*`/semantic anchors over LinkedIn's randomized CSS classes.

---

## Quick start — one-click (Claude Desktop)

The lowest-friction path is the **Desktop Extension bundle** (`.mcpb`):

1. Download `linkedin-mcp.mcpb` (from Releases) and **double-click it** — Claude Desktop registers the server with no config editing and no restart.
2. On first use, the desktop app **launches itself** and opens LinkedIn; **log in once** (2FA/captcha included). That session persists.

That's it — no `npx`, no JSON, no Chromium download. Write actions stay **disabled** until you fill in the extension's "Enable write actions" field (see [Write actions are off by default](#write-actions-are-off-by-default)).

Build the bundle yourself from a checkout:

```bash
npm run pack:mcpb      # builds dist/ and packs linkedin-mcp.mcpb
```

## Quick start — npx / other MCP clients

No clone required:

```bash
npx -y @mehmoodqureshi/linkedin-mcp
```

The server is **connect-only**, so there's no browser download. It attaches to the LinkedIn desktop app; if the app isn't running, the server **launches it for you** on first use, then drives that visible window. Add the server to your client config (see [Connecting to an MCP client](#connecting-to-an-mcp-client)) — for Claude Code that's a single command:

```bash
claude mcp add linkedin -- npx -y @mehmoodqureshi/linkedin-mcp
```

```bash
npx -y @mehmoodqureshi/linkedin-mcp --help      # usage + config snippet
npx -y @mehmoodqureshi/linkedin-mcp --version
```

The same package also ships the Electron desktop app (tray + activity log) — see [How to run](#how-to-run) to build it from source.

---

## Prerequisites

- **Node.js 20+** (the project targets ES2022 / modern Electron).
- **npm** (ships with Node).

No separate browser download is needed — the app uses Electron's bundled Chromium and the connect-only server attaches to it. Install dependencies with:

```bash
npm install
```

---

## How to run

> Just want the MCP server? Use the [npx quick start](#quick-start-npx). This section covers the optional Electron desktop app, built from a source checkout.

```bash
npm start
```

This launches the Electron control panel (UI mode). From there you can:

1. **Start Driver** – launches the persistent Chromium.
2. **Sign In** – opens LinkedIn's login page in the controlled browser. Enter your credentials and complete any 2FA/captcha **manually** in that window. Once you reach the feed, the session is persisted.
3. Watch the **Session** panel flip to *authenticated* and the **Activity Log** for progress.

To rebuild the compiled output (main + renderer) without packaging:

```bash
npm run build       # tsc for main/driver/mcp + renderer + copy index.html
npm run typecheck   # type-check only, no emit
```

Packaging (requires the missing `assets/` and `build/` files, see Known issues):

```bash
npm run pack        # unpacked build
npm run dist        # platform installer(s)
```

---

## Connecting to an MCP client

MCP clients discover servers from a JSON config — for Claude Desktop:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\\Claude\\claude_desktop_config.json`

(Claude Code: `claude mcp add`; other clients use the same `command`/`args` shape.)

### Recommended — npx (no checkout)

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/linkedin-mcp"]
    }
  }
}
```

This server is **connect-only**: it drives the LinkedIn **desktop app's** browser over CDP and never launches its own. Start the app first — the server auto-discovers and attaches to it; with no app running, actions return an actionable "start the app" error.

Optional `env` overrides: `LINKEDIN_MCP_USERDATA` (data dir, default `~/.linkedin-mcp`) and `LINKEDIN_CDP_ENDPOINT` (CDP endpoint of the app to attach to — defaults to the running app, auto-discovered).

### Windows

WSL2 is **not** required — native Windows works. One config change is, though: on Windows `npx` is `npx.cmd`, a batch shim, and MCP hosts spawn the server without a shell, which cannot execute a `.cmd`. So `"command": "npx"` fails to start. Wrap it in `cmd /c`:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@mehmoodqureshi/linkedin-mcp"]
    }
  }
}
```

Or: `claude mcp add linkedin -- cmd /c npx -y @mehmoodqureshi/linkedin-mcp`

### Alternative — Electron desktop app (from a source checkout)

Runs the same MCP server embedded in the tray app, so you get a control-panel window alongside it:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "./node_modules/.bin/electron",
      "args": ["."],
      "cwd": "/absolute/path/to/linkedin-mcp",
      "env": { "LINKEDIN_MCP_STDIO": "1" }
    }
  }
}
```

Notes:
- **Restart the client** after editing the config.
- Both paths share the same persistent session on disk, so logging in once via either is enough.
- The MCP server keeps stdout reserved for JSON-RPC; all diagnostics go to stderr.

---

## MCP tools

All tools are namespaced `linkedin_*`. Auth/status tools work without being logged in; every data/action tool requires an authenticated session (call `linkedin_login` first).

| Tool | Arguments | Description |
| --- | --- | --- |
| `linkedin_login` | `email?`, `password?` | Opens the headed login flow. Optionally pre-fills credentials; you finish 2FA/captcha by hand. Waits for the session, then persists it. The password is never stored. |
| `linkedin_logout` | – | Clears the saved `storageState` snapshot and the profile cookies; next action needs a fresh login. |
| `linkedin_status` | – | Returns `{ status, isLoggedIn, sessionValid }`. Works before the browser is launched. |
| `linkedin_get_profile` | `profileUrl` (full URL or `/in/` slug) | Opens and scrapes a member profile: name, headline, location, about, experience, education, skills, connection count. |
| `linkedin_update_profile` | `firstName?`, `lastName?`, `headline?`, `location?`, `about?` (≥1 required) | Updates **your own** profile via the Edit intro / Edit about modals. Returns per-field outcome (updated / unchanged / failed). Write action — gated by `LINKEDIN_ALLOW_MUTATIONS`. Structured sections (experience/education/skills) not yet supported. |
| `linkedin_search_people` | `query`, `filters?` | People search; returns name, headline, location, profile URL, connection degree. |
| `linkedin_search_jobs` | `query`, `filters?` | Jobs search; returns title, company, location, posted date, easy-apply, job URL. |
| `linkedin_search_companies` | `query`, `filters?` | Company search; returns name, industry, followers, company URL. |
| `linkedin_send_message` | `profileUrl`, `message` | Sends a DM to a 1st-degree/open-profile member. Fails clearly if messaging isn't permitted. |
| `linkedin_send_connection` | `profileUrl`, `note?` (<=300 chars) | Sends a connection request, optionally with a note. Returns outcome: sent / already_sent / already_connected / unavailable. |
| `linkedin_get_feed` | `limit?` (1–50, default 10) | Reads home-feed posts: author, text, timestamp, like/comment counts, post URL. |
| `linkedin_get_notifications` | `limit?` (1–50, default 20) | Reads notifications: type, actor, text, timestamp, URL, read/unread. |
| `linkedin_get_conversations` | – | Lists inbox threads: participant, snippet, conversation id, timestamp, unread state. |
| `linkedin_get_messages` | `conversationId` (id or thread URL) | Reads one thread's messages in order: sender, text, timestamp. |

Each tool returns a JSON payload inside the standard MCP text-content envelope. On failure the result carries `isError: true` with an actionable message (e.g. "Not logged in to LinkedIn. Run linkedin_login…").

> The advertised `filters` schemas for the search tools are richer than the filters the driver currently applies; treat advanced filters as best-effort for now (see Known issues).

---

## Session persistence

Two cooperating layers keep you logged in across restarts:

1. **Persistent Chromium profile (primary).** The browser runs against an on-disk profile directory (`<userData>/playwright-profile`). Cookies, localStorage, and IndexedDB live there and survive app restarts on their own — exactly like a normal browser that "remembers" you.

2. **Portable `storageState` snapshot (secondary).** On login (and on graceful close) the app also writes `<userData>/linkedin-session.json`. This gives:
   - a fast, **browser-free** "am I logged in?" check by inspecting the LinkedIn `li_at` cookie and its expiry (no Chromium launch required), and
   - a **recovery path**: if the profile is corrupted, a fresh context can be re-hydrated by re-injecting the snapshot's cookies via `context.addCookies(...)`.

`<userData>` is Electron's per-app data directory (e.g. `~/Library/Application Support/LinkedIn MCP/` on macOS). Outside Electron it falls back to `$LINKEDIN_MCP_USERDATA` or `~/.linkedin-mcp`.

**Validity** is determined by the presence of a non-expired `li_at` cookie. A session cookie (`expires === -1`) is treated as valid. `linkedin_status` / the UI surface this as `sessionValid`, while `isLoggedIn` additionally confirms against the live page when a context is up.

**Logging out** (`linkedin_logout` / the Logout button) clears the profile cookies and deletes the snapshot, forcing a fresh manual login next time.

The session files contain live credentials-equivalent cookies — `.gitignore` already excludes `userData/`, `pw-profile/`, and any `storageState.json`. **Never commit a logged-in session.**

---

## Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional:

- `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` – optional pre-fill for auto-login. **Not recommended**; manual headed login is preferred and required for 2FA/captcha accounts.
- `MCP_LOG_LEVEL` – `error|warn|info|debug|trace`.
- `LINKEDIN_MCP_STDIO` – set to `1` when launched by Claude Desktop as a stdio MCP server (the config injects this).
- `PLAYWRIGHT_BROWSERS_PATH` – override the Playwright browsers location (packaged builds point this at the bundled Chromium).

---

## Project layout

```
src/
  main/        Electron main process: lifecycle, window, tray, IPC, bootstrapping
    index.ts
    ipc-handlers.ts
  preload/     Context-isolated bridge exposed as window.linkedinMCP
    index.ts
  driver/      Playwright automation layer
    browser.ts     BrowserManager (persistent context, singleton)
    session.ts     SessionManager (storageState persist/validate/recover)
    linkedin.ts    LinkedInDriver facade (composes the action modules)
    types.ts       Shared normalized result types
    actions/       auth, profile, search, messages, connections, feed (+ common, index)
  mcp/         MCP server + tool catalog/dispatch
    server.ts
    tools.ts
    claude-desktop-config.ts
  renderer/    Control-panel UI (sandboxed, no Node)
    index.html
    app.ts
```

---

## Write actions are off by default

Every state-changing tool is **deny-by-default**. With `LINKEDIN_ALLOW_MUTATIONS` unset, these are refused:

`linkedin_send_message`, `linkedin_send_connection`, `linkedin_accept_invitation`, `linkedin_withdraw_invitation`, `linkedin_react`, `linkedin_comment`, `linkedin_update_profile`

Opt in with a comma-separated allowlist, or `all` / `*` for everything:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/linkedin-mcp"],
      "env": { "LINKEDIN_ALLOW_MUTATIONS": "send_message,react" }
    }
  }
}
```

Read-only tools (profiles, search, feed, notifications) always work and need no opt-in.

Allowed writes are additionally capped per day — 40 connections, 60 messages, 150 reactions, 30 comments — resetting at local midnight. Call `linkedin_get_quota` to see remaining budget.

---

## Disclaimer

Automating LinkedIn may violate its Terms of Service and can lead to rate limiting or account restriction. Use a real, consenting account, keep volumes low, and run this only for personal, lawful purposes. You are responsible for how you use it.
