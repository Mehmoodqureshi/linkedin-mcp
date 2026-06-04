/**
 * ConnectMcp — onboarding step 1: "Connect the MCP Server".
 *
 * Explains how to register the LinkedIn MCP server with an AI client and gives
 * per-client instructions (Claude Desktop, Claude Code, Cursor). Picking a
 * client shows its copyable config/command. "Continue" advances to the
 * Connect-Your-LinkedIn step.
 */

import React, { useState } from 'react';

import { AppShell } from './shell';

const PACKAGE = '@mehmoodqureshi/linkedin-mcp';

export type McpClient = 'claude-desktop' | 'claude-code' | 'cursor';

interface ClientConfig {
  client: McpClient;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  tag: { label: string; variant: 'auto' | 'manual' | 'accent' };
  /** Where the snippet goes / what it is. */
  hint: string;
  /** Label for the copy button (config vs command). */
  copyLabel: string;
  snippet: string;
}

/** JSON block shared by config-file based clients (Claude Desktop, Cursor). */
const JSON_CONFIG = `{
  "mcpServers": {
    "linkedin-driver": {
      "command": "npx",
      "args": ["-y", "${PACKAGE}"],
      "env": { "LINKEDIN_MCP_STDIO": "1" }
    }
  }
}`;

const CLIENTS: ClientConfig[] = [
  {
    client: 'claude-desktop',
    icon: <ClaudeIcon />,
    title: 'Claude Desktop',
    subtitle: 'Add to claude_desktop_config.json',
    tag: { label: 'Recommended', variant: 'auto' },
    hint: 'Copy the config, paste it into claude_desktop_config.json, then restart Claude.',
    copyLabel: 'Copy config',
    snippet: JSON_CONFIG,
  },
  {
    client: 'claude-code',
    icon: <TerminalIcon />,
    title: 'Claude Code',
    subtitle: 'Register via the CLI',
    tag: { label: 'CLI', variant: 'accent' },
    hint: 'Copy the command and run it once in your terminal.',
    copyLabel: 'Copy command',
    snippet: `claude mcp add linkedin-driver --env LINKEDIN_MCP_STDIO=1 -- npx -y ${PACKAGE}`,
  },
  {
    client: 'cursor',
    icon: <CursorIcon />,
    title: 'Cursor',
    subtitle: 'Add to ~/.cursor/mcp.json',
    tag: { label: 'Manual', variant: 'manual' },
    hint: 'Copy the config and paste it into ~/.cursor/mcp.json.',
    copyLabel: 'Copy config',
    snippet: JSON_CONFIG,
  },
];

export interface ConnectMcpProps {
  /** Advance to the next onboarding step. */
  onContinue?: () => void;
}

export function ConnectMcp({ onContinue }: ConnectMcpProps): JSX.Element {
  const [selected, setSelected] = useState<McpClient>('claude-desktop');
  const [copied, setCopied] = useState(false);

  const active = CLIENTS.find((c) => c.client === selected) ?? CLIENTS[0]!;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(active.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the block is selectable as a fallback */
    }
  };

  return (
    <AppShell>
      <div className="rw-content">
        <StepIndicator step={1} />
        <h1 className="rw-title">Connect the MCP Server</h1>
        <p className="rw-subtitle">
          Add LinkedIn-mcp to your AI client so it can drive LinkedIn for you. Pick your client,
          copy the config, then continue.
        </p>

        <div className="rw-options">
          {CLIENTS.map((c) => (
            <button
              key={c.client}
              type="button"
              className={`rw-option${c.client === selected ? ' rw-option--selected' : ''}`}
              aria-pressed={c.client === selected}
              onClick={() => {
                setSelected(c.client);
                setCopied(false);
              }}
            >
              <span className="rw-option__icon">{c.icon}</span>
              <span className="rw-option__text">
                <span className="rw-option__title">{c.title}</span>
                <span className="rw-option__subtitle">{c.subtitle}</span>
              </span>
              <span className={`rw-tag rw-tag--${c.tag.variant}`}>{c.tag.label}</span>
            </button>
          ))}
        </div>

        <div className="rw-copybar">
          <span className="rw-copybar__hint">{active.hint}</span>
          <button
            type="button"
            className={`rw-btn rw-btn--ghost rw-copybtn${copied ? ' rw-copybtn--done' : ''}`}
            onClick={() => void copy()}
          >
            {copied ? '✓ Copied' : active.copyLabel}
          </button>
        </div>

        <div className="rw-actions">
          <button type="button" className="rw-btn" onClick={() => onContinue?.()}>
            I&apos;ve connected — Continue →
          </button>
        </div>
      </div>
    </AppShell>
  );
}

export default ConnectMcp;

/* ------------------------------------------------------------------ */
/* Step indicator + client glyphs                                      */
/* ------------------------------------------------------------------ */

function StepIndicator({ step }: { step: 1 | 2 }): JSX.Element {
  return (
    <div className="rw-steps" aria-label={`Step ${step} of 2`}>
      <span className={`rw-step ${step === 1 ? 'rw-step--active' : 'rw-step--done'}`}>
        <span className="rw-step__dot">{step === 1 ? '1' : '✓'}</span>
        Connect MCP
      </span>
      <span className="rw-steps__bar" />
      <span className={`rw-step ${step === 2 ? 'rw-step--active' : ''}`}>
        <span className="rw-step__dot">2</span>
        Connect LinkedIn
      </span>
    </div>
  );
}

function ClaudeIcon(): JSX.Element {
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <rect width="50" height="50" rx="12" fill="#D97757" />
      <path
        d="M25 13l3.2 7.9L36 24l-7.8 3.1L25 35l-3.2-7.9L14 24l7.8-3.1L25 13z"
        fill="#fff"
      />
    </svg>
  );
}

function TerminalIcon(): JSX.Element {
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <rect width="50" height="50" rx="12" fill="#1F1F21" stroke="#2f3236" />
      <path d="M16 19l6 6-6 6" stroke="#4e9768" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M27 33h8" stroke="#4e9768" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function CursorIcon(): JSX.Element {
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" fill="none" aria-hidden="true">
      <rect width="50" height="50" rx="12" fill="#101113" stroke="#2f3236" />
      <path d="M19 16l16 7.5-7 2.2L25 33l-6-17z" fill="#D6D8DA" />
    </svg>
  );
}
