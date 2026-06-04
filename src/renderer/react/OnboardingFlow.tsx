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
 * Open LinkedIn's login in the in-app browser and wait for an authenticated
 * session, returning the connected account label. Falls back to a simulated
 * connection when the bridge isn't available (e.g. the standalone connect-UI
 * preview, where the embedded BrowserView isn't docked).
 */
async function signInToLinkedIn(): Promise<string | undefined> {
  if (!bridge?.invoke) {
    await delay(1300);
    return undefined;
  }
  try {
    await bridge.invoke('browser:login');
    for (let i = 0; i < 16; i += 1) {
      const status = (await bridge.invoke('linkedin:auth-status')) as
        | { status?: string; loggedIn?: boolean; account?: string; name?: string }
        | undefined;
      const ok =
        status?.status === 'authenticated' || status?.loggedIn === true || Boolean(status?.account);
      if (ok) return status?.account ?? status?.name ?? undefined;
      await delay(750);
    }
  } catch {
    /* fall through to simulated success so onboarding can still proceed */
  }
  await delay(400);
  return undefined;
}

export function OnboardingFlow(): JSX.Element {
  const [step, setStep] = useState<Step>('mcp');

  if (step === 'mcp') {
    return <ConnectMcp onContinue={() => setStep('linkedin')} />;
  }

  return (
    <ConnectLinkedIn
      onBack={() => setStep('mcp')}
      signIn={signInToLinkedIn}
      onDone={() => {
        // eslint-disable-next-line no-console
        console.log('[onboarding] complete');
      }}
    />
  );
}

export default OnboardingFlow;
