/**
 * Stdio↔socket bridge.
 *
 * When the desktop app is already running, a SECOND process launched in MCP
 * mode (by Claude Desktop) cannot get the single-instance lock and cannot open
 * its own LinkedIn browser without racing the first. Instead of quitting, it
 * runs THIS bridge: it connects to the primary instance's local MCP socket and
 * pipes its own stdin/stdout through, so Claude Desktop transparently talks to
 * the already-running app — and drives the SAME in-app BrowserView the user
 * sees.
 *
 * This is a dumb byte pump: the primary serves the actual MCP protocol over the
 * socket; we just forward Claude's JSON-RPC stream to it and stream replies back.
 * If the socket can't be reached (e.g. the primary is itself a headless MCP
 * instance with no socket), we fall back via `onUnavailable` to the previous
 * behaviour (quit), which is no worse than before.
 */

import net from 'node:net';

/**
 * Connect to the primary instance's MCP socket and bridge process stdio to it.
 * Calls `onUnavailable()` if the initial connection fails.
 */
export function runStdioBridge(socketPath: string, onUnavailable: () => void): void {
  let connected = false;

  const socket = net.connect(socketPath);

  socket.on('connect', () => {
    connected = true;
    process.stderr.write('[bridge] attached to running LinkedIn MCP app.\n');
    // Wire the two streams together. Claude's requests → primary; replies back.
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on('error', (err) => {
    process.stderr.write(`[bridge] could not reach the running app: ${String(err)}\n`);
    // Only treat a pre-connection error as "unavailable"; a mid-stream error
    // just ends the session.
    if (!connected) onUnavailable();
  });

  // When either side hangs up, end the process cleanly so Claude Desktop sees
  // the server close rather than a wedged pipe.
  socket.on('close', () => {
    if (connected) process.exit(0);
  });
  process.stdin.on('end', () => socket.end());
}
