/**
 * React entry for the onboarding flow ("Connect the MCP" -> "Connect Your
 * LinkedIn").
 *
 * Bundled by esbuild into dist/renderer/connect.{js,css} and loaded by
 * connect.html. The Electron main process serves this page (instead of the
 * default index.html) when LINKEDIN_CONNECT_UI=1, so it renders inside the real
 * app window. The renderer is sandboxed (no Node), so everything is
 * self-contained in the bundle.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import { OnboardingFlow } from './OnboardingFlow';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Connect UI: #root container not found');
}

createRoot(container).render(
  <React.StrictMode>
    <OnboardingFlow />
  </React.StrictMode>,
);
