#!/usr/bin/env node
/**
 * Standalone CLI entry point — the `npx`-distributable path.
 *
 * Runs the LinkedIn MCP server over stdio WITHOUT Electron. The desktop app
 * (`src/main/index.ts`) embeds the same MCP server inside an Electron tray app;
 * this entry instead boots it as a plain Node process so it can be launched
 * directly by any MCP client:
 *
 *     npx @mehmoodqureshi/linkedin-mcp
 *
 * The driver, MCP server, and tool layer are all Electron-free (they lazily
 * `require('electron')` only to locate Electron's userData dir, and fall back to
 * `$LINKEDIN_MCP_USERDATA` or `~/.linkedin-mcp` when it is absent), so nothing
 * here pulls Electron in.
 *
 * CRITICAL: in stdio mode, stdout carries the JSON-RPC stream. Never write
 * human-readable text to stdout — all diagnostics go to stderr. Help/version
 * output is fine because those exit before the server starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startMcpServer, stopMcpServer } from './mcp/server';
import { getInstance } from './driver/linkedin';

/** Read the shipped package.json (one level up from dist/cli.js) for metadata. */
function readPkg(): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

function printHelp(): void {
  const { name = 'linkedin-mcp', version = '?' } = readPkg();
  process.stdout.write(
    `${name} v${version} — LinkedIn automation as an MCP server (stdio)\n\n` +
      `Usage:\n` +
      `  npx @mehmoodqureshi/linkedin-mcp            Start the MCP server over stdio\n` +
      `  npx @mehmoodqureshi/linkedin-mcp --help     Show this help\n` +
      `  npx @mehmoodqureshi/linkedin-mcp --version  Print the version\n\n` +
      `This binary speaks the Model Context Protocol over stdin/stdout, so it is\n` +
      `normally launched by an MCP client (Claude Desktop, Claude Code, etc.)\n` +
      `rather than run by hand. Add it to your client config, e.g.:\n\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `      "linkedin": {\n` +
      `        "command": "npx",\n` +
      `        "args": ["-y", "@mehmoodqureshi/linkedin-mcp"]\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `Environment:\n` +
      `  LINKEDIN_MCP_USERDATA   Override the data dir (default: ~/.linkedin-mcp)\n` +
      `  LINKEDIN_HEADLESS=1     Launch Chromium headless (default: headed, so you\n` +
      `                          can complete the one-time manual login)\n` +
      `  LINKEDIN_USER_DATA_DIR  Alias for the driver's persistent profile dir\n`,
  );
}

function printVersion(): void {
  const { version = '0.0.0' } = readPkg();
  process.stdout.write(`${version}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    printVersion();
    return;
  }

  // Eagerly create the driver singleton (browser launch stays lazy inside it),
  // then bind the MCP server to stdio. Connecting the stdio transport keeps the
  // event loop alive (it reads stdin), so the process stays up serving requests
  // until the client disconnects or sends a termination signal.
  getInstance();
  await startMcpServer();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await stopMcpServer();
        await getInstance().close();
      } catch (err) {
        process.stderr.write(`[cli] error during shutdown: ${String(err)}\n`);
      } finally {
        process.exit(code);
      }
    })();
  };

  // MCP clients terminate the server with SIGTERM/SIGINT on shutdown. We do NOT
  // attach our own stdin reader — the stdio transport owns stdin, and a second
  // reader would corrupt the JSON-RPC stream.
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[cli] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
