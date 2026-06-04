# Changes — Embedded browser, quota guardrails & multi-instance MCP bridge

**Commit:** `f25bed1` — _feat: embedded in-app browser, quota guardrails, and multi-instance MCP bridge_
**Branch:** `main` (pushed to `origin/main`)
**Scope:** 18 files changed, 2,353 insertions, 492 deletions

This document explains, in plain terms, what this commit changes and why.

---

## TL;DR

Three big things landed together:

1. **The LinkedIn browser is now hosted natively inside the app** (a real Electron `BrowserView`), instead of a streamed screencast. The user clicks/types it directly, and the automation drives the *same* view.
2. **Daily safety caps** on mutating actions (connect / message / react / comment) so the app can't get the account flagged by LinkedIn's automation limits.
3. **A second MCP process now bridges into the already-running app** instead of fighting it for the browser, so Claude Desktop and the desktop app can coexist.

Plus a smoke test and a Figma MCP entry for design-to-code work.

---

## New files

### `src/driver/quota.ts` — `QuotaManager`
Per-day caps on **mutating** actions only (reads are never limited).

- Actions metered: `connection`, `message`, `reaction`, `comment`.
- Conservative default ceilings (below LinkedIn's real, fuzzy limits) to leave
  headroom for the user's own manual activity:
  `connection: 40`, `message: 60`, `reaction: 150`, `comment: 30`.
- Each cap is overridable via env (`LINKEDIN_CAP_CONNECTION`, etc.).
- Counts **persist** to `userData/linkedin-quota.json` and **reset at local
  midnight** (keyed by calendar date).
- Core API:
  - `enforce(action)` — throws `QuotaError` *before* an action runs if it would exceed the cap.
  - `record(action)` — increments and persists after success.
  - `guard(action, fn)` — the convenient `enforce → run → record` wrapper.
  - `snapshot()` — today's usage vs caps, for the UI/status surface.
- Fails **safe**: if the action would exceed the cap it's refused up front; if
  the quota file is unwritable, the already-successful action is not blocked
  (we just lose durability of that one count).

### `src/main/embedded-browser.ts` — `EmbeddedBrowser`
Hosts LinkedIn natively in the renderer's right pane.

- Creates an Electron `BrowserView` with a **persistent session partition**
  (`persist:linkedin`) so login survives restarts, and a **pinned Chrome
  user-agent** so it doesn't advertise "Electron".
- Docks the view into the window and keeps its bounds matched to the renderer's
  `#stage` pane (`browser:bounds`).
- Drives toolbar / nav-rail controls: `browser:navigate` / `:back` /
  `:forward` / `:reload` / `:login`.
- Reflects navigation + load state back to the URL bar (`browser:url` /
  `browser:loading`).
- Allows identity-provider auth popups (e.g. "Continue with Google") to open as
  real windows; everything else is routed to the system browser.
- The Playwright automation layer attaches **over CDP** to this same web
  contents, so the agent's actions appear live in the very view the user sees.

### `src/main/mcp-bridge.ts` — `runStdioBridge`
Lets a second process coexist with the running app.

- When the desktop app is already running, a second process launched in MCP mode
  (by Claude Desktop) can't get the single-instance lock or safely open its own
  browser.
- Instead of quitting, it connects to the primary instance's local MCP **socket**
  and **pipes its own stdin/stdout through** — Claude transparently talks to the
  already-running app and drives the same in-app `BrowserView`.
- It's a dumb byte pump; the primary serves the real MCP protocol over the socket.
- If the socket can't be reached, it falls back via `onUnavailable()` to the
  previous behaviour (quit) — no worse than before.

### `test/connect-smoke.js`
Electron smoke test for the connect flow. Run with `npm run test:smoke`.

---

## Modified files

| File | What changed |
|------|--------------|
| `src/driver/browser.ts` | Added CDP **connect** mode so Playwright attaches to the embedded `BrowserView` instead of launching its own browser; hardened recovery. |
| `src/driver/linkedin.ts` | Wired the driver to the embedded/attached browser lifecycle. |
| `src/driver/actions/common.ts` | Shared plumbing for quota guards around mutating actions. |
| `src/driver/actions/connections.ts` | `connection` actions now run under the quota guard. |
| `src/driver/actions/messages.ts` | `message` actions now run under the quota guard. |
| `src/driver/actions/feed.ts` | `reaction` / `comment` actions now run under the quota guard. |
| `src/main/index.ts` | Boot logic: single-instance handling, embedded-browser wiring, and MCP-bridge fallback when a primary is already running. |
| `src/main/ipc-handlers.ts` | New IPC channels for the embedded browser controls + quota snapshot. |
| `src/mcp/server.ts` | Serves MCP over the local socket (so the bridge can attach) alongside stdio. |
| `src/preload/index.ts` | Exposed the new `browser:*` and quota IPC to the renderer. |
| `src/renderer/app.ts` / `index.html` | UI for the docked browser pane, toolbar/URL bar, and status surface. |
| `.mcp.json` | Added a **figma** MCP server (`figma-developer-mcp`) for design-to-code work; reads `FIGMA_API_KEY` from env. |
| `package.json` | Added the `test:smoke` script. |

---

## How the pieces fit

```
Claude Desktop ── stdio ──► [2nd process: mcp-bridge] ── socket ──► [running app: mcp/server]
                                                                          │
                                                          drives ◄────────┤ CDP attach
                                                                          ▼
                                                            EmbeddedBrowser (BrowserView)
                                                                          │
                                              every mutating action ──► QuotaManager.guard()
```

- The user sees and interacts with the real LinkedIn page in the app.
- The agent attaches to that same page and acts on it.
- Every connect/message/react/comment passes the daily safety cap first.
- A second MCP client doesn't conflict — it bridges into the running app.

---

## Try it

```bash
npm run build
npm start            # launch the desktop app
npm run test:smoke   # Electron smoke test of the connect flow
```

Tune caps if needed (examples):

```bash
LINKEDIN_CAP_CONNECTION=25 LINKEDIN_CAP_MESSAGE=40 npm start
```
