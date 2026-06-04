/**
 * ConnectLinkedIn — onboarding step 2: "Connect Your LinkedIn".
 *
 * Faithful React port of Figma frame 2946:4001 ("Frame 16091"). Uses the shared
 * AppShell for the brand header / frame. The two connection paths:
 *   - Chrome Extension     -> tagged "Auto"   (recommended, automated)
 *   - LinkedIn Credentials -> tagged "Manual"
 */

import React from 'react';

import { AppShell } from './shell';

export type ConnectMethod = 'chrome-extension' | 'credentials';

export interface ConnectLinkedInProps {
  /** Fired when the user picks a connection method. */
  onSelect?: (method: ConnectMethod) => void;
  /** Go back to the previous onboarding step. Omit to hide the back button. */
  onBack?: () => void;
}

interface OptionConfig {
  method: ConnectMethod;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  tag: { label: string; variant: 'auto' | 'manual' };
}

const OPTIONS: OptionConfig[] = [
  {
    method: 'chrome-extension',
    icon: <ChromeLogo />,
    title: 'Chrome Extension',
    subtitle: 'Unlock the full power of LinkedIn-mcp',
    tag: { label: 'Auto', variant: 'auto' },
  },
  {
    method: 'credentials',
    icon: <LinkedInLogo />,
    title: 'LinkedIn Credentials',
    subtitle: 'Unlock the full power of LinkedIn-mcp',
    tag: { label: 'Manual', variant: 'manual' },
  },
];

export function ConnectLinkedIn({ onSelect, onBack }: ConnectLinkedInProps): JSX.Element {
  return (
    <AppShell>
      <div className="rw-content">
        <StepIndicator />
        <h1 className="rw-title">Connect Your LinkedIn</h1>
        <p className="rw-subtitle">Unlock the full power by connecting your LinkedIn account</p>

        <div className="rw-options">
          {OPTIONS.map((opt) => (
            <button
              key={opt.method}
              type="button"
              className="rw-option"
              onClick={() => onSelect?.(opt.method)}
            >
              <span className="rw-option__icon">{opt.icon}</span>
              <span className="rw-option__text">
                <span className="rw-option__title">{opt.title}</span>
                <span className="rw-option__subtitle">{opt.subtitle}</span>
              </span>
              <span className={`rw-tag rw-tag--${opt.tag.variant}`}>{opt.tag.label}</span>
            </button>
          ))}
        </div>

        {onBack && (
          <div className="rw-actions rw-actions--split">
            <button type="button" className="rw-btn rw-btn--ghost" onClick={() => onBack()}>
              ← Back
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default ConnectLinkedIn;

/* ------------------------------------------------------------------ */
/* Step indicator + brand glyphs                                       */
/* ------------------------------------------------------------------ */

function StepIndicator(): JSX.Element {
  return (
    <div className="rw-steps" aria-label="Step 2 of 2">
      <span className="rw-step rw-step--done">
        <span className="rw-step__dot">✓</span>
        Connect MCP
      </span>
      <span className="rw-steps__bar" />
      <span className="rw-step rw-step--active">
        <span className="rw-step__dot">2</span>
        Connect LinkedIn
      </span>
    </div>
  );
}

function ChromeLogo(): JSX.Element {
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <circle cx="25" cy="25" r="24" fill="#fff" />
      <circle cx="25" cy="25" r="9" fill="#fff" stroke="#4B8BF4" strokeWidth="3.2" />
      <path d="M25 16h21a24 24 0 0 0-41-3l10.5 18A9 9 0 0 1 25 16z" fill="#DD5044" />
      <path d="M25 34a9 9 0 0 1-7.8-4.5L6.5 11.3A24 24 0 0 0 16 44l9-10z" fill="#19A15F" />
      <path d="M33.5 20a9 9 0 0 1-8.5 14l-9 10A24 24 0 0 0 46 16H25a9 9 0 0 1 8.5 4z" fill="#FFCD42" />
    </svg>
  );
}

function LinkedInLogo(): JSX.Element {
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <rect width="50" height="50" rx="8" fill="#006699" />
      <path
        d="M16.2 19.5h-5v16h5v-16zm.3-5a2.9 2.9 0 1 0-5.8 0 2.9 2.9 0 0 0 5.8 0zM39 35.5v-9.3c0-4.6-2.5-6.7-5.8-6.7a5 5 0 0 0-4.5 2.5v-2.5h-5v16h5v-8.4c0-2.2.4-4.3 3.1-4.3s2.7 2.5 2.7 4.5v8.2H39z"
        fill="#fff"
      />
    </svg>
  );
}
