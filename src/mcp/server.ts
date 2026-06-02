/**
 * MCP server bootstrap for the LinkedIn driver.
 *
 * This module wires the `@modelcontextprotocol/sdk` {@link Server} to a
 * {@link StdioServerTransport} so that an MCP client (Claude Desktop) can drive
 * the LinkedIn automation over stdin/stdout using JSON-RPC.
 *
 * Responsibilities:
 *   - construct the `Server` with our identity (`linkedin-driver` / `1.0.0`)
 *     and declare the `tools` capability,
 *   - register every tool from `tools.ts` via `registerTools`,
 *   - install crash-safety so a thrown handler never corrupts the transport,
 *   - connect the stdio transport and keep it alive,
 *   - expose `startMcpServer()` (called by the main process) and a matching
 *     `stopMcpServer()` for clean shutdown.
 *
 * CRITICAL: when running as an MCP stdio server, **nothing** may be written to
 * stdout except the JSON-RPC stream — any stray `console.log` would corrupt the
 * protocol. All diagnostics therefore go to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const SERVER_NAME = 'linkedin-driver';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The live server instance, or null when stopped. Kept so we can stop it. */
let server: Server | null = null;

/** The live transport, or null when stopped. */
let transport: StdioServerTransport | null = null;

// ---------------------------------------------------------------------------
// Logging (stderr only — never stdout in stdio mode)
// ---------------------------------------------------------------------------

function logErr(message: string): void {
  process.stderr.write(`[mcp] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

/**
 * Build a fresh `Server` with our capabilities and the full tool surface
 * registered. Pure: creates and returns the instance without connecting any
 * transport, so it is easy to unit-test.
 */
export function createServer(): Server {
  const srv = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        // We expose tools only — no prompts/resources surface for now.
        tools: {},
      },
    },
  );

  // Register the ListTools + CallTool handlers. `registerTools` already wraps
  // each tool invocation in try/catch (via dispatchToolCall) and returns a
  // structured `isError` result instead of throwing, so a failing tool can
  // never tear down the transport.
  registerTools(srv);

  // Belt-and-suspenders: surface any protocol-level error to stderr instead of
  // letting it bubble out unobserved.
  srv.onerror = (err: unknown): void => {
    logErr(`server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  };

  return srv;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the MCP server over stdio. Idempotent: a second call while already
 * running is a no-op. Called by the main process during bootstrap.
 *
 * The returned promise resolves once the transport is connected and the server
 * is ready to receive JSON-RPC requests; the process then stays alive serving
 * requests until `stopMcpServer()` is called or stdin closes.
 */
export async function startMcpServer(): Promise<void> {
  if (server) {
    logErr('startMcpServer called but server is already running; ignoring.');
    return;
  }

  const srv = createServer();
  const tx = new StdioServerTransport();

  try {
    await srv.connect(tx);
  } catch (err) {
    logErr(`failed to connect stdio transport: ${String(err)}`);
    // Leave module state clean so a retry can succeed.
    server = null;
    transport = null;
    throw err;
  }

  server = srv;
  transport = tx;
  logErr(`${SERVER_NAME} v${SERVER_VERSION} connected over stdio.`);
}

/**
 * Stop the MCP server and release the stdio transport. Idempotent: safe to call
 * when already stopped. Best-effort — failures are logged but never thrown, so
 * shutdown is never blocked.
 */
export async function stopMcpServer(): Promise<void> {
  const srv = server;
  if (!srv) return;

  // Drop references first so a re-entrant call short-circuits.
  server = null;
  const tx = transport;
  transport = null;

  try {
    await srv.close();
  } catch (err) {
    logErr(`error while closing server: ${String(err)}`);
  }

  try {
    await tx?.close();
  } catch (err) {
    logErr(`error while closing transport: ${String(err)}`);
  }

  logErr('MCP server stopped.');
}

/** Whether the MCP server is currently connected and serving. */
export function isMcpServerRunning(): boolean {
  return server !== null;
}
