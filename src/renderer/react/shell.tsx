/**
 * Shared onboarding shell: the dark app frame, brand header, and wave glyph
 * used by every onboarding screen (Connect the MCP, Connect Your LinkedIn).
 * Faithful to Figma frame 2946:4001's chrome.
 */

import React from 'react';
import './onboarding.css';

export const BRAND_NAME = 'mehmoodqureshi/LinkedIn-mcp';

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rw-screen">
      <header className="rw-header">
        <div className="rw-brand">
          <BrandMark />
          <span className="rw-brand__name">{BRAND_NAME}</span>
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

      <main className="rw-main">{children}</main>

      <WaveDecoration />
    </div>
  );
}

export function BrandMark(): JSX.Element {
  // Link/chain glyph — two interlocking links for "LinkedIn-mcp".
  return (
    <svg className="rw-brand__mark" width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <rect x="3" y="11" width="15" height="8" rx="4" stroke="#378FE9" strokeWidth="2.4" />
      <rect x="12" y="11" width="15" height="8" rx="4" stroke="#378FE9" strokeWidth="2.4" />
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
