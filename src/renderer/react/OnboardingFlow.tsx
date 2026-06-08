/**
 * OnboardingFlow — drives the two onboarding steps in order:
 *   1. Connect the MCP server to an AI client  (ConnectMcp)
 *   2. Connect your LinkedIn account           (ConnectLinkedIn)
 */

import { useState } from 'react';

import { ConnectMcp } from './ConnectMcp';
import { ConnectLinkedIn } from './ConnectLinkedIn';

type Step = 'mcp' | 'linkedin';

/** Minimal view of the preload bridge (`window.linkedinMCP`). */
type McpBridge = { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> };

const bridge = (window as unknown as { linkedinMCP?: McpBridge }).linkedinMCP;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Open LinkedIn's OWN login page in a dedicated in-app window (the user enters
 * their credentials directly on linkedin.com). Resolves with the connected
 * account label once authenticated, or rejects if the user closes the window
 * without signing in. Falls back to a simulated connection only when the bridge
 * isn't available at all (pure design preview opened outside the app).
 */
async function signInToLinkedIn(): Promise<string | undefined> {
  if (!bridge?.invoke) {
    await delay(1300);
    return undefined;
  }
  const result = (await bridge.invoke('linkedin:open-login')) as
    | { authenticated?: boolean }
    | undefined;
  if (!result?.authenticated) {
    throw new Error('sign-in cancelled');
  }
  // Best-effort: surface the member's name if the driver can report it.
  try {
    const status = (await bridge.invoke('linkedin:auth-status')) as
      | { account?: string; name?: string }
      | undefined;
    return status?.account ?? status?.name ?? undefined;
  } catch {
    return undefined;
  }
}

export function OnboardingFlow(): JSX.Element {
  // The main process can deep-link into a specific step via the URL hash
  // (e.g. connect.html#linkedin opens step 2 directly — used on logout).
  const initialStep: Step = window.location.hash.replace(/^#/, '') === 'linkedin' ? 'linkedin' : 'mcp';
  const [step, setStep] = useState<Step>(initialStep);

  if (step === 'mcp') {
    return <ConnectMcp onContinue={() => setStep('linkedin')} />;
  }

  return (
    <ConnectLinkedIn
      onBack={() => setStep('mcp')}
      signIn={signInToLinkedIn}
      checkAuth={async () => {
        const r = (await bridge?.invoke?.('linkedin:session-state')) as
          | { authenticated?: boolean }
          | undefined;
        return Boolean(r?.authenticated);
      }}
      lastAccount={async () => {
        const r = (await bridge?.invoke?.('linkedin:last-account')) as
          | { name?: string; avatarDataUrl?: string }
          | null
          | undefined;
        return r && r.name ? { name: r.name, avatarDataUrl: r.avatarDataUrl } : null;
      }}
      logOut={async () => {
        await bridge?.invoke?.('linkedin:clear-session');
      }}
      onDone={() => {
        // Hand off to the main control panel (loads index.html + docks the
        // LinkedIn view). No-op in a standalone preview without the bridge.
        void bridge?.invoke?.('app:open-main');
      }}
    />
  );
}

export default OnboardingFlow;
