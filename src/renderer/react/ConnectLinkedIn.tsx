/**
 * ConnectLinkedIn — onboarding step 2: "Connect Your LinkedIn".
 *
 * Secure in-app sign-in: a single "Sign in to LinkedIn" action opens LinkedIn's
 * OWN login page inside the app's embedded browser (no password entry here, so
 * 2FA / Google SSO just work and we never see credentials). The screen reflects
 * idle -> connecting -> connected, with the connected account once known.
 */

import { useEffect, useState } from 'react';

import { AppShell } from './shell';

type Status = 'idle' | 'connecting' | 'connected' | 'error';

export interface ConnectLinkedInProps {
  /** Go back to the previous onboarding step. */
  onBack?: () => void;
  /** Called once the account is connected. */
  onDone?: () => void;
  /**
   * Perform the real sign-in. Resolve with a label for the connected account
   * (e.g. the member's name). If omitted, a short demo connection is simulated.
   */
  signIn?: () => Promise<string | undefined>;
  /** Check whether a LinkedIn session already exists (to show "Connected"). */
  checkAuth?: () => Promise<boolean>;
  /**
   * The last member who signed in (name + avatar), surviving sign-out, so we can
   * offer a one-tap "Continue as …" tile. Resolve null when nobody is remembered.
   */
  lastAccount?: () => Promise<{ name: string; avatarDataUrl?: string } | null>;
  /** Sign out of LinkedIn (clears the session), returning to the idle state. */
  logOut?: () => Promise<void>;
}

export function ConnectLinkedIn({
  onBack,
  onDone,
  signIn,
  checkAuth,
  lastAccount,
  logOut,
}: ConnectLinkedInProps): JSX.Element {
  const [status, setStatus] = useState<Status>('idle');
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [remembered, setRemembered] = useState<{ name: string; avatarDataUrl?: string } | null>(
    null,
  );

  const connecting = status === 'connecting';
  const connected = status === 'connected';

  // On mount: load the remembered member (for the "Continue as …" tile) and the
  // live session state together. We only auto-jump to "Connected" when there is
  // NO remembered member — when there IS one we always show the chooser tile, and
  // its click either resumes the still-live session in one tap (soft sign-out) or
  // re-authenticates (hard sign-out / expired).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = lastAccount ? await lastAccount() : null;
      if (cancelled) return;
      setRemembered(a);
      if (!a && checkAuth) {
        const ok = await checkAuth();
        if (!cancelled && ok) setStatus('connected');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lastAccount, checkAuth]);

  const handleSignIn = async (): Promise<void> => {
    if (connecting) return;
    setStatus('connecting');
    try {
      const label = signIn ? await signIn() : await simulateSignIn();
      setAccount(label);
      setStatus('connected');
    } catch {
      setStatus('error');
    }
  };

  // Returning member tile. If their session is still alive (soft sign-out),
  // resume straight into the app — no login window, no credentials. Only when the
  // session is gone do we fall back to a full sign-in.
  const handleContinueAs = async (): Promise<void> => {
    if (connecting) return;
    setStatus('connecting');
    try {
      const stillValid = checkAuth ? await checkAuth() : false;
      if (stillValid) {
        onDone?.();
        return;
      }
      const label = signIn ? await signIn() : await simulateSignIn();
      setAccount(label);
      setStatus('connected');
    } catch {
      setStatus('error');
    }
  };

  // "Use a different account": hard sign-out (wipe the session) so the login page
  // doesn't silently resume the remembered member, then open a fresh sign-in.
  const handleDifferentAccount = async (): Promise<void> => {
    if (connecting) return;
    setRemembered(null);
    try {
      await logOut?.();
    } catch {
      /* ignore — proceed to sign-in regardless */
    }
    await handleSignIn();
  };

  const handleLogOut = async (): Promise<void> => {
    try {
      await logOut?.();
    } finally {
      setAccount(undefined);
      setStatus('idle');
    }
  };

  return (
    <AppShell>
      <div className="rw-content">
        <StepIndicator done={connected} />
        <h1 className="rw-title">Connect Your LinkedIn</h1>
        <p className="rw-subtitle">
          Sign in securely so LinkedIn-mcp can act on your behalf.
        </p>

        <div className="rw-options">
          {connected ? (
            <div className="rw-signin rw-signin--ok" role="status">
              <span className="rw-option__icon"><LinkedInLogo /></span>
              <span className="rw-option__text">
                <span className="rw-option__title">Connected</span>
                <span className="rw-option__subtitle">
                  Signed in{account ? ` as ${account}` : ''}
                </span>
              </span>
              <span className="rw-signin__cta"><CheckIcon /></span>
            </div>
          ) : remembered ? (
            <>
              {/* Returning member: a one-tap tile with their avatar. */}
              <button
                type="button"
                className="rw-signin rw-signin--member"
                onClick={() => void handleContinueAs()}
                disabled={connecting}
                aria-busy={connecting}
              >
                <span className="rw-option__icon">
                  <Avatar name={remembered.name} src={remembered.avatarDataUrl} />
                </span>
                <span className="rw-option__text">
                  <span className="rw-option__title">
                    {connecting ? 'Signing in…' : `Continue as ${remembered.name}`}
                  </span>
                  <span className="rw-option__subtitle">
                    {status === 'error'
                      ? 'Something went wrong — tap to try again'
                      : 'Resume your session — no password needed'}
                  </span>
                </span>
                <span className="rw-signin__cta">{connecting ? <Spinner /> : '→'}</span>
              </button>
              <button
                type="button"
                className="rw-altsignin"
                onClick={() => void handleDifferentAccount()}
                disabled={connecting}
              >
                Use a different account
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rw-signin"
              onClick={() => void handleSignIn()}
              disabled={connecting}
              aria-busy={connecting}
            >
              <span className="rw-option__icon"><LinkedInLogo /></span>
              <span className="rw-option__text">
                <span className="rw-option__title">
                  {connecting ? 'Connecting…' : 'Sign in to LinkedIn'}
                </span>
                <span className="rw-option__subtitle">
                  {status === 'error'
                    ? 'Something went wrong — tap to try again'
                    : "Opens LinkedIn's official login"}
                </span>
              </span>
              <span className="rw-signin__cta">{connecting ? <Spinner /> : '→'}</span>
            </button>
          )}
        </div>

        <p className="rw-note">
          <LockIcon />
          You&apos;ll log in on LinkedIn&apos;s official page in a secure in-app window. We never
          see or store your password.
        </p>

        <div className="rw-actions rw-actions--split">
          <button type="button" className="rw-btn rw-btn--ghost" onClick={() => onBack?.()}>
            ← Back
          </button>
          {connected && (
            <span className="rw-actions__group">
              <button type="button" className="rw-btn rw-btn--ghost" onClick={() => void handleLogOut()}>
                Log out
              </button>
              <button type="button" className="rw-btn" onClick={() => onDone?.()}>
                Finish →
              </button>
            </span>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default ConnectLinkedIn;

/** Fallback used when no real `signIn` is wired (e.g. design preview). */
function simulateSignIn(): Promise<string | undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), 1300));
}

/* ------------------------------------------------------------------ */
/* Step indicator + glyphs                                             */
/* ------------------------------------------------------------------ */

function StepIndicator({ done }: { done: boolean }): JSX.Element {
  return (
    <div className="rw-steps" aria-label="Step 2 of 2">
      <span className="rw-step rw-step--done">
        <span className="rw-step__dot">✓</span>
        Connect MCP
      </span>
      <span className="rw-steps__bar" />
      <span className={`rw-step ${done ? 'rw-step--done' : 'rw-step--active'}`}>
        <span className="rw-step__dot">{done ? '✓' : '2'}</span>
        Connect LinkedIn
      </span>
    </div>
  );
}

/** Remembered member's avatar — their photo, or initials if none was captured. */
function Avatar({ name, src }: { name: string; src?: string }): JSX.Element {
  if (src) {
    return <img className="rw-avatar" src={src} alt={name} width={50} height={50} />;
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span className="rw-avatar rw-avatar--initials" aria-hidden="true">
      {initials || '?'}
    </span>
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

function LockIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="rw-note__lock">
      <rect x="3" y="7" width="10" height="7" rx="2" stroke="#87898b" strokeWidth="1.4" />
      <path d="M5 7V5.5a3 3 0 0 1 6 0V7" stroke="#87898b" strokeWidth="1.4" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#19A15F" />
      <path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner(): JSX.Element {
  return <span className="rw-spinner" aria-hidden="true" />;
}
