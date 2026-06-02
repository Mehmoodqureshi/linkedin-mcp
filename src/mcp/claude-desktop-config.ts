/**
 * Claude Desktop configuration helper.
 *
 * Claude Desktop discovers MCP servers from a `claude_desktop_config.json` file
 * (under `mcpServers`). This module builds the exact snippet a user needs to add
 * so Claude Desktop launches *this* Electron app as a stdio MCP server, and
 * prints it to the console for easy copy/paste.
 *
 * The server is launched with `electron .` from the project directory, with the
 * `LINKEDIN_MCP_STDIO` env var set so the main process knows it was spawned as
 * an MCP command (and therefore must keep stdout clean for JSON-RPC).
 */

import { resolve } from 'node:path';

/** Logical key Claude Desktop uses to identify this server in its config. */
const SERVER_KEY = 'linkedin-driver';

/** Shape of a single `mcpServers` entry in claude_desktop_config.json. */
export interface ClaudeDesktopServerEntry {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** Shape of the snippet the user merges into their Claude Desktop config. */
export interface ClaudeDesktopConfigSnippet {
  mcpServers: Record<string, ClaudeDesktopServerEntry>;
}

/**
 * Build the Claude Desktop config snippet for this MCP server.
 *
 * @param projectDir Absolute path to the project root (defaults to the current
 *   working directory). This is used both as `cwd` and is where `electron .`
 *   resolves the app from.
 */
export function buildClaudeDesktopConfig(
  projectDir: string = process.cwd(),
): ClaudeDesktopConfigSnippet {
  const cwd = resolve(projectDir);
  return {
    mcpServers: {
      [SERVER_KEY]: {
        command: 'electron',
        args: ['.'],
        cwd,
        env: {
          // Signals the main process it was spawned as an MCP stdio server, so
          // it binds stdin/stdout to the JSON-RPC stream and keeps stdout clean.
          LINKEDIN_MCP_STDIO: '1',
        },
      },
    },
  };
}

/**
 * Print the Claude Desktop config snippet the user must add to their
 * `claude_desktop_config.json` (typically at
 * `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or
 * `%APPDATA%/Claude/claude_desktop_config.json` on Windows).
 *
 * @param projectDir Absolute path to the project root (defaults to cwd).
 */
export function printClaudeDesktopConfig(
  projectDir: string = process.cwd(),
): void {
  const snippet = buildClaudeDesktopConfig(projectDir);

  // Human-facing instructions go to stderr so this helper is safe to call even
  // when stdout is reserved for the JSON-RPC stream. The JSON itself is logged
  // for easy copy/paste.
  process.stderr.write(
    '\nAdd the following to your Claude Desktop config ' +
      '(claude_desktop_config.json), merging into any existing "mcpServers":\n\n',
  );
  console.log(JSON.stringify(snippet, null, 2));
  process.stderr.write(
    '\nConfig file locations:\n' +
      "  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json\n" +
      '  Windows: %APPDATA%\\Claude\\claude_desktop_config.json\n' +
      'Restart Claude Desktop after saving.\n\n',
  );
}
