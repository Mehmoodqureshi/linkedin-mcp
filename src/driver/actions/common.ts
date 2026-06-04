/**
 * Shared helpers and primitives for the LinkedIn action modules.
 *
 * Everything here is selector-engine and timing glue. The action classes
 * (auth, profile, search, messages, connections, feed) build on top of these
 * utilities so that rate-limiting, human-like pacing, and robust selector
 * fallbacks live in exactly one place.
 *
 * Design notes:
 *   - LinkedIn ships randomized/obfuscated CSS class names that rotate between
 *     deploys, so we NEVER select on `.css-xxxx` style classes. We prefer, in
 *     order: ARIA roles + accessible names, `data-*` attributes (LinkedIn keeps
 *     several semantic ones stable, e.g. `data-control-name`, `data-view-name`),
 *     stable id prefixes, and semantic HTML (h1/main/section/nav).
 *   - Every "action" (a write, a navigation, a click that mutates state) is
 *     paced with a >= 2s delay to stay under LinkedIn's automated-activity
 *     radar. Reads inside a single page are not delayed.
 */

import type { Page } from 'playwright';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base origin for all LinkedIn navigation. */
export const LINKEDIN_BASE = 'https://www.linkedin.com';

/**
 * Minimum delay, in milliseconds, inserted between rate-sensitive actions
 * (navigations, sends, connects, likes). 2s is the floor mandated by the spec;
 * we jitter slightly above it to look less robotic.
 */
export const ACTION_DELAY_MS = 2000;

/** Default navigation timeout. LinkedIn is SPA-heavy and occasionally slow. */
export const NAV_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inserts the mandatory anti-rate-limit delay between actions, with a small
 * random jitter (0–600ms) on top of the 2s floor.
 */
export function rateLimitDelay(): Promise<void> {
  const jitter = Math.floor(Math.random() * 600);
  return sleep(ACTION_DELAY_MS + jitter);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an action requires an authenticated session but none is present
 * (or the session expired). Carries a stable `code` so the IPC/MCP layer can
 * surface a `needs_login` outcome instead of a raw stack trace.
 */
export class NeedsLoginError extends Error {
  readonly code = 'needs_login';
  constructor(message = 'Not authenticated to LinkedIn. Please log in first.') {
    super(message);
    this.name = 'NeedsLoginError';
  }
}

/**
 * Thrown when LinkedIn interrupts with a security checkpoint / verification
 * (CAPTCHA, "unusual activity", phone/email confirm). Distinct from
 * NeedsLoginError: the session is valid, the user just has to clear a human
 * challenge. Because the in-app browser is interactive, the right response is to
 * surface this so the user solves it IN THE PANE, then retries — not to treat it
 * as a logged-out state.
 */
export class CheckpointError extends Error {
  readonly code = 'needs_verification';
  constructor(
    message = 'LinkedIn needs you to verify your identity. Complete the check in the browser pane, then retry.',
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/** Thrown when a targeted element/page could not be found within timeout. */
export class ActionError extends Error {
  readonly code: string;
  constructor(message: string, code = 'action_failed') {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Navigates to a URL and waits for the DOM to be interactive. We deliberately
 * wait for `domcontentloaded` rather than `networkidle` because LinkedIn keeps
 * long-poll/websocket connections open that never go idle.
 */
export async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  // Give client-side hydration a beat to paint the initial view.
  await sleep(1200);
}

/**
 * True if the URL is a security checkpoint / verification challenge — the
 * session is valid but a human challenge gates access.
 */
export function isCheckpointUrl(url: string): boolean {
  return url.includes('/checkpoint') || url.includes('/challenge');
}

/**
 * True if the current page looks like a LinkedIn auth wall (login / "join now").
 * Checkpoints are handled separately (see {@link isCheckpointUrl}).
 */
export function isAuthWallUrl(url: string): boolean {
  return (
    url.includes('/login') ||
    url.includes('/authwall') ||
    url.includes('/uas/login') ||
    url.includes('signup')
  );
}

/**
 * Guard to call right after navigating to a member-only page:
 *   - a checkpoint redirect → {@link CheckpointError} ('needs_verification'),
 *     so the caller can prompt the user to solve it in the pane;
 *   - any other auth wall → {@link NeedsLoginError} ('needs_login').
 */
export function assertAuthenticated(page: Page): void {
  const url = page.url();
  if (isCheckpointUrl(url)) {
    throw new CheckpointError();
  }
  if (isAuthWallUrl(url)) {
    throw new NeedsLoginError();
  }
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/**
 * Incrementally scrolls the page to force LinkedIn's lazy lists (feed, search
 * results, notifications) to load more items. Stops when the target count of
 * `itemSelector` matches is reached or the page height stops growing.
 */
export async function autoScroll(
  page: Page,
  itemSelector: string,
  targetCount: number,
  maxScrolls = 25,
): Promise<void> {
  let lastHeight = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.locator(itemSelector).count();
    if (count >= targetCount) return;

    const height = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });

    await sleep(900 + Math.floor(Math.random() * 400));

    if (height === lastHeight) {
      // One more nudge in case a "show more" button gates additional content.
      await page.evaluate(() => window.scrollBy(0, -400));
      await sleep(600);
      const grown = await page.evaluate(() => document.body.scrollHeight);
      if (grown === lastHeight) return; // truly exhausted
    }
    lastHeight = height;
  }
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Collapses whitespace and trims; returns undefined for empty results. */
export function clean(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length ? t : undefined;
}

/**
 * Tries a list of locators (by selector string) and returns the trimmed text
 * of the first one that resolves to a visible element. Robust against
 * LinkedIn's frequently-renamed class names: pass several candidate selectors
 * ordered from most-stable (aria/data/semantic) to least.
 */
export async function firstText(
  page: Page,
  selectors: readonly string[],
): Promise<string | undefined> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const txt = await loc.textContent({ timeout: 2000 });
      const c = clean(txt);
      if (c) return c;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/** Resolves the first matching, visible locator from candidate selectors. */
export async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = 4000,
): Promise<import('playwright').Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        // ignore and keep polling
      }
    }
    await sleep(250);
  }
  return null;
}

/** URL-encodes a value for use in a LinkedIn search querystring. */
export function enc(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Normalize a profile reference to a canonical `/in/<slug>/` URL. Accepts a full
 * http(s) URL (returned as-is), an `/in/<slug>` path, or a BARE vanity slug.
 *
 * This mirrors ProfileActions so every module resolves profiles identically. A
 * bare slug must never be concatenated straight onto the origin — `${BASE}${slug}`
 * yields `https://www.linkedin.comslug` (ERR_NAME_NOT_RESOLVED), the exact bug
 * that bit send_connection / send_message when handed a bare slug.
 */
export function normalizeProfileUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  const slug = input.replace(/^\/+|\/+$/g, '').replace(/^in\//, '');
  return `${LINKEDIN_BASE}/in/${slug}/`;
}

/**
 * Resolve an arbitrary LinkedIn reference (e.g. a post permalink) to an absolute
 * URL. Full http(s) URLs pass through; anything else is treated as a path and
 * joined to the origin with exactly one leading slash — so a missing or extra
 * leading slash can never produce a malformed host.
 */
export function resolveLinkedInUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  return `${LINKEDIN_BASE}/${input.replace(/^\/+/, '')}`;
}
