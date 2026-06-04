/**
 * React entry for the "Connect Your LinkedIn" screen.
 *
 * Bundled by esbuild into dist/renderer/connect.{js,css} and loaded by
 * connect.html. The Electron main process serves this page (instead of the
 * default index.html) when LINKEDIN_CONNECT_UI=1, so the screen renders inside
 * the real app window. The renderer is sandboxed (no Node), so everything is
 * self-contained in the bundle.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import { ConnectLinkedIn, type ConnectMethod } from './ConnectLinkedIn';

function handleSelect(method: ConnectMethod): void {
  // Hook point for the real connect flows. The preload exposes a guarded
  // `window.linkedinMCP` bridge; until the connect IPC channels are wired we
  // just log so the screen is usable as a standalone view.
  // eslint-disable-next-line no-console
  console.log(`[connect] selected method: ${method}`);
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Connect UI: #root container not found');
}

createRoot(container).render(
  <React.StrictMode>
    <ConnectLinkedIn onSelect={handleSelect} />
  </React.StrictMode>,
);
