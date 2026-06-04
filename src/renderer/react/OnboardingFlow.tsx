/**
 * OnboardingFlow — drives the two onboarding steps in order:
 *   1. Connect the MCP server to an AI client  (ConnectMcp)
 *   2. Connect your LinkedIn account           (ConnectLinkedIn)
 */

import { useState } from 'react';

import { ConnectMcp } from './ConnectMcp';
import { ConnectLinkedIn, type ConnectMethod } from './ConnectLinkedIn';

type Step = 'mcp' | 'linkedin';

export function OnboardingFlow(): JSX.Element {
  const [step, setStep] = useState<Step>('mcp');

  if (step === 'mcp') {
    return <ConnectMcp onContinue={() => setStep('linkedin')} />;
  }

  return (
    <ConnectLinkedIn
      onBack={() => setStep('mcp')}
      onSelect={(method: ConnectMethod) => {
        // eslint-disable-next-line no-console
        console.log(`[connect] LinkedIn method: ${method}`);
      }}
    />
  );
}

export default OnboardingFlow;
