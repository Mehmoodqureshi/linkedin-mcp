/**
 * ConnectLinkedIn — onboarding screen ("Connect Your LinkedIn").
 *
 * Faithful React port of Figma frame 2946:4001 ("Frame 16091") from the
 * Reach Wise file. Self-contained: no design-system or UI-library dependency,
 * styles live in the co-located ConnectLinkedIn.css. The layout is centered and
 * responsive rather than pinned to the source's 1920x1080 artboard, so it drops
 * into any React app.
 *
 * The two connection paths from the frame:
 *   - Chrome Extension  -> tagged "Auto"   (recommended, automated)
 *   - LinkedIn Credentials -> tagged "Manual"
 */

import React from 'react';
import './ConnectLinkedIn.css';

export type ConnectMethod = 'chrome-extension' | 'credentials';

export interface ConnectLinkedInProps {
  /** Fired when the user picks a connection method. */
  onSelect?: (method: ConnectMethod) => void;
  /** Header brand label. Defaults to the frame's "Reachwise". */
  brandName?: string;
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
    subtitle: 'Unlock the full power of Reachwise',
    tag: { label: 'Auto', variant: 'auto' },
  },
  {
    method: 'credentials',
    icon: <LinkedInLogo />,
    title: 'LinkedIn Credentials',
    subtitle: 'Unlock the full power of Reachwise',
    tag: { label: 'Manual', variant: 'manual' },
  },
];

export function ConnectLinkedIn({ onSelect, brandName = 'Reachwise' }: ConnectLinkedInProps): JSX.Element {
  return (
    <div className="rw-screen">
      <header className="rw-header">
        <div className="rw-brand">
          <BrandMark />
          <span className="rw-brand__name">{brandName}</span>
        </div>
        <div className="rw-header__actions">
          <button className="rw-iconbtn" aria-label="Search" type="button">
            <SearchIcon />
          </button>
          <span className="rw-header__divider" aria-hidden="true" />
          <button className="rw-iconbtn" aria-label="Notifications" type="button">
            <BellIcon />
          </button>
        </div>
      </header>

      <main className="rw-main">
        <div className="rw-content">
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
        </div>
      </main>

      <WaveDecoration />
    </div>
  );
}

export default ConnectLinkedIn;

/* ------------------------------------------------------------------ */
/* Inline SVG assets (recreated from the frame; brand glyphs approximated) */
/* ------------------------------------------------------------------ */

function BrandMark(): JSX.Element {
  return (
    <svg className="rw-brand__mark" width="28" height="26" viewBox="0 0 28 26" fill="none" aria-hidden="true">
      <path d="M3 23V3h11a6 6 0 0 1 0 12H8" stroke="#378FE9" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 15l8 8" stroke="#378FE9" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
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

function SearchIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="9.5" cy="9.5" r="6.5" stroke="#949698" strokeWidth="2" />
      <path d="M15 15l4 4" stroke="#949698" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon(): JSX.Element {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" fill="none" aria-hidden="true">
      <path
        d="M9 2a6 6 0 0 0-6 6c0 4-1.5 6-1.5 6h15S15 12 15 8a6 6 0 0 0-6-6z"
        stroke="#949698"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M7 17a2 2 0 0 0 4 0" stroke="#949698" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function WaveDecoration(): JSX.Element {
  return (
    <svg className="rw-wave" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M2 40c8 0 8-16 16-16s8 16 16 16 8-16 16-16 8 16 12 16"
        stroke="#1E1F22"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
