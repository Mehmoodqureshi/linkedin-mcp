/**
 * Connection actions: send / accept / withdraw connection requests and read
 * pending received invitations.
 *
 * Connecting is the most rate-sensitive LinkedIn action, so every state-
 * mutating step is paced via `rateLimitDelay`. Notes are capped at 300 chars
 * (LinkedIn's hard limit) and truncated defensively.
 */

import type { Locator, Page } from 'playwright';

import {
  LINKEDIN_BASE,
  ActionError,
  assertAuthenticated,
  clean,
  navigate,
  normalizeProfileUrl,
  rateLimitDelay,
  sleep,
} from './common';
import { getQuotaManager } from '../quota';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LinkedIn's hard cap on connection-request note length. */
export const MAX_NOTE_LENGTH = 300;

export interface ConnectionRequestResult {
  success: boolean;
  /** True when a personalized note was attached. */
  noteAttached: boolean;
  /**
   * Outcome classification for the caller:
   *  - 'sent'          request dispatched
   *  - 'already_sent'  a pending invite already exists
   *  - 'already_connected'
   *  - 'unavailable'   no Connect affordance (e.g. follow-only)
   */
  outcome: 'sent' | 'already_sent' | 'already_connected' | 'unavailable';
  message: string;
}

export interface PendingRequest {
  profileId?: string;
  name?: string;
  headline?: string;
  profileUrl?: string;
}

// ---------------------------------------------------------------------------
// ConnectionActions
// ---------------------------------------------------------------------------

export class ConnectionActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // sendConnectionRequest
  // -------------------------------------------------------------------------

  /**
   * Opens the target profile and clicks "Connect". If the primary action row
   * only exposes "Follow"/"Message", the Connect option is sought inside the
   * "More" overflow menu. With a note, the "Add a note" path is taken.
   */
  async sendConnectionRequest(
    profileUrl: string,
    note?: string,
  ): Promise<ConnectionRequestResult> {
    // Fail fast if we're already at today's invite cap (before any navigation).
    await getQuotaManager().enforce('connection');

    const url = normalizeProfileUrl(profileUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // Already connected? The top card shows a "Message" primary with no Connect.
    if ((await this.page.locator('main button:has-text("Pending")').count()) > 0) {
      return {
        success: false,
        noteAttached: false,
        outcome: 'already_sent',
        message: 'A connection request is already pending.',
      };
    }

    // Derive the profile owner's name so we don't accidentally click a
    // "Connect" button belonging to a suggested-people rail on the same page.
    const ownerName = (await this.page.title())
      .replace(/\(\d+\)\s*/g, '')
      .replace(/\s*\|\s*LinkedIn.*$/i, '')
      .trim();
    const { button: connectBtn, connected } = await this.locateConnectButton(ownerName);
    if (!connectBtn) {
      // No Connect affordance. Distinguish "already a 1st-degree connection"
      // (a Remove-connection / "· 1st" signal was seen) from a genuinely
      // follow-only / unreachable profile.
      if (connected) {
        return {
          success: false,
          noteAttached: false,
          outcome: 'already_connected',
          message: 'Already connected to this member (1st-degree).',
        };
      }
      return {
        success: false,
        noteAttached: false,
        outcome: 'unavailable',
        message: 'No "Connect" affordance available on this profile.',
      };
    }

    await rateLimitDelay();
    await connectBtn.click();
    await sleep(1200);

    let noteAttached = false;
    const trimmedNote = note ? note.slice(0, MAX_NOTE_LENGTH) : undefined;

    if (trimmedNote) {
      const addNote = this.page
        .locator('button[aria-label="Add a note"], button:has-text("Add a note")')
        .first();
      if ((await addNote.count()) > 0) {
        await addNote.click();
        await sleep(800);
        const textarea = this.page
          .locator('textarea[name="message"], #custom-message, textarea[id*="custom-message"]')
          .first();
        if ((await textarea.count()) > 0) {
          await textarea.fill(trimmedNote);
          noteAttached = true;
          await sleep(500);
        }
      }
    }

    await rateLimitDelay();
    const sendBtn = this.page
      .locator(
        'button[aria-label="Send now"], ' +
          'button[aria-label="Send invitation"], ' +
          'button:has-text("Send")',
      )
      .first();

    if ((await sendBtn.count()) === 0) {
      throw new ActionError('Could not find the Send button in the invite dialog.', 'send_missing');
    }
    await sendBtn.click();
    await sleep(1200);

    // Count the invite only once it was actually dispatched.
    await getQuotaManager().record('connection');

    return {
      success: true,
      noteAttached,
      outcome: 'sent',
      message: noteAttached ? 'Connection request sent with note.' : 'Connection request sent.',
    };
  }

  // -------------------------------------------------------------------------
  // getConnectionRequests
  // -------------------------------------------------------------------------

  /** Lists pending *received* invitations from the invitation manager. */
  async getConnectionRequests(): Promise<PendingRequest[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/mynetwork/invitation-manager/received/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await rateLimitDelay();
    // Invitation cards use obfuscated classes; anchor on the inviter's /in/
    // link, take its enclosing <li>, and parse the visible text lines:
    //   ["<Name>", "<headline>", "<N mutual connections>", "Ignore", "Accept"]
    // Deduped by profile href, keeping the richest card.
    const cards = await this.page.evaluate(() => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;
      const links = Array.from(root.querySelectorAll('a[href*="/in/"]'));
      const byHref = new Map<string, string[]>();
      const order: string[] = [];
      for (const a of links) {
        const raw = a.getAttribute('href') ?? '';
        if (!raw) continue;
        const key = (raw.split('?')[0] ?? raw).replace(/\/$/, '');
        const li = a.closest('li') ?? a.parentElement;
        if (!li) continue;
        const seen = new Set<string>();
        const lines = (li.innerText ?? '')
          .split('\n')
          .map(norm)
          .filter((t) => {
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
          });
        const prev = byHref.get(key);
        if (!prev) order.push(key);
        if (!prev || lines.length > prev.length) byHref.set(key, lines);
      }
      return order
        .slice(0, 40)
        .map((href) => ({ href, lines: byHref.get(href) ?? [] }));
    });

    const out: PendingRequest[] = [];
    const NOISE_RE =
      /^(ignore|accept|message|withdraw)$|mutual connection|invited you to subscribe|follows you/i;
    for (const { href, lines } of cards) {
      const meaningful = lines.filter((l) => !NOISE_RE.test(l));
      const name = clean(meaningful[0]);
      // Skip non-connection invites (e.g. newsletter "invited you to subscribe").
      if (!name || lines.some((l) => /invited you to subscribe/i.test(l))) {
        continue;
      }
      const headline = clean(meaningful[1]);

      const item: PendingRequest = {};
      const abs = href.startsWith('http') ? href : `${LINKEDIN_BASE}${href}`;
      item.profileUrl = abs.split('?')[0] ?? abs;
      const id = this.parseProfileId(href);
      if (id) item.profileId = id;
      item.name = name;
      if (headline) item.headline = headline;
      out.push(item);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // acceptConnectionRequest
  // -------------------------------------------------------------------------

  /**
   * Accepts a pending received invitation. `profileId` is the vanity slug of
   * the inviter; we locate their card in the invitation manager and click
   * its "Accept" button.
   */
  async acceptConnectionRequest(profileId: string): Promise<{ success: boolean; message: string }> {
    await navigate(this.page, `${LINKEDIN_BASE}/mynetwork/invitation-manager/received/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // The invitation card uses obfuscated classes (and isn't always an <li>), so
    // find the nearest ancestor of the inviter's profile link that contains an
    // Accept button — robust to the surrounding container type.
    const card = this.page
      .locator(
        `xpath=//a[contains(@href, "/in/${profileId}")]/ancestor::*[.//button[contains(@aria-label, "Accept") or contains(., "Accept")]][1]`,
      )
      .first();

    if ((await card.count()) === 0) {
      throw new ActionError(`No pending invitation found for "${profileId}".`, 'not_found');
    }

    const acceptBtn = card
      .locator('button[aria-label*="Accept" i], button:has-text("Accept")')
      .first();
    if ((await acceptBtn.count()) === 0) {
      throw new ActionError('Accept button not found on the invitation card.', 'accept_missing');
    }

    await rateLimitDelay();
    await acceptBtn.click();
    await sleep(1000);

    return { success: true, message: `Accepted invitation from ${profileId}.` };
  }

  // -------------------------------------------------------------------------
  // withdrawConnectionRequest
  // -------------------------------------------------------------------------

  /** Withdraws a previously *sent* invitation from the sent-invitations tab. */
  async withdrawConnectionRequest(
    profileId: string,
  ): Promise<{ success: boolean; message: string }> {
    await navigate(this.page, `${LINKEDIN_BASE}/mynetwork/invitation-manager/sent/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const card = this.page
      .locator(
        `xpath=//a[contains(@href, "/in/${profileId}")]/ancestor::*[.//button[contains(@aria-label, "Withdraw") or contains(., "Withdraw")]][1]`,
      )
      .first();

    if ((await card.count()) === 0) {
      throw new ActionError(`No sent invitation found for "${profileId}".`, 'not_found');
    }

    const withdrawBtn = card
      .locator('button[aria-label*="Withdraw" i], button:has-text("Withdraw")')
      .first();
    if ((await withdrawBtn.count()) === 0) {
      throw new ActionError('Withdraw button not found.', 'withdraw_missing');
    }

    await rateLimitDelay();
    await withdrawBtn.click();
    await sleep(800);

    // A confirmation dialog typically appears.
    const confirm = this.page
      .locator('button[aria-label="Withdraw"], button:has-text("Withdraw")')
      .last();
    if ((await confirm.count()) > 0) {
      await confirm.click().catch(() => undefined);
      await sleep(800);
    }

    return { success: true, message: `Withdrew invitation to ${profileId}.` };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Finds the Connect button, checking the primary action row first and then
   * the "More" overflow menu (where LinkedIn often relegates Connect for
   * 2nd/3rd-degree members).
   *
   * Returns `{ button, connected }`: `button` is the owner's Connect/Invite
   * affordance (null when none exists), and `connected` is true when a
   * 1st-degree signal was observed (a "Remove connection" menu entry or the
   * "· 1st" degree badge) so the caller can report `already_connected` rather
   * than `unavailable`.
   */
  private async locateConnectButton(
    ownerName?: string,
  ): Promise<{ button: Locator | null; connected: boolean }> {
    // 1. Prefer the OWNER's own invite button. LinkedIn names it
    //    "Invite <Full Name> to connect", so scoping by name avoids clicking a
    //    "Connect" in a suggested-people rail (which would invite the wrong
    //    person). Escape quotes in the name for the attribute selector.
    if (ownerName) {
      const safe = ownerName.replace(/"/g, '\\"');
      // LinkedIn renders the top-card actions TWICE (the main card + a sticky
      // scroll header); the sticky copy is hidden until you scroll, so a bare
      // .first() can resolve to a non-visible element and make us miss a present
      // Connect. It also renders the owner's Connect as an <a> on some profiles
      // and a <button> on others, so match BOTH. Iterate and take the first
      // VISIBLE owner-invite affordance.
      const named = this.page.locator(
        `main button[aria-label*="Invite ${safe}"], ` +
          `main a[aria-label*="Invite ${safe}"]`,
      );
      const namedCount = await named.count();
      for (let i = 0; i < namedCount; i++) {
        const btn = named.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          return { button: btn, connected: false };
        }
      }
    }

    // 2. Follow-primary profiles relegate Connect to the overflow ("More") menu.
    //    There can be several "More" buttons in the top-card region, so try each
    //    in turn: open it and look for the owner's Connect/Invite entry, scoped
    //    by the owner's name when we have it (plain "Connect" otherwise). The
    //    menu belongs to the owner, so its Connect targets the right person.
    const safeName = ownerName ? ownerName.replace(/"/g, '\\"') : '';
    const menuSel = ownerName
      ? `div[role="menu"] [aria-label*="Invite ${safeName}"], ` +
        `div.artdeco-dropdown__content [aria-label*="Invite ${safeName}"], ` +
        `div[role="menu"] :text-is("Connect")`
      : `div[role="menu"] [aria-label^="Invite"], ` +
        `div.artdeco-dropdown__content [aria-label^="Invite"], ` +
        `div[role="menu"] :text-is("Connect")`;
    const moreButtons = this.page.locator(
      'main button[aria-label="More actions"], main button[aria-label="More"]',
    );
    const moreCount = Math.min(await moreButtons.count(), 3);
    let connected = false;
    for (let i = 0; i < moreCount; i++) {
      await moreButtons.nth(i).click().catch(() => undefined);
      await sleep(700);
      // A "Remove connection" entry in the owner's menu means we're already
      // 1st-degree — record it so a null Connect maps to already_connected.
      if (
        !connected &&
        (await this.page
          .locator(
            'div[role="menu"] :text-is("Remove connection"), ' +
              'div.artdeco-dropdown__content :text-is("Remove connection")',
          )
          .count()) > 0
      ) {
        connected = true;
      }
      const inMenu = this.page.locator(menuSel).first();
      if (
        (await inMenu.count()) > 0 &&
        (await inMenu.isVisible().catch(() => false))
      ) {
        return { button: inMenu, connected };
      }
      // Close this menu before trying the next "More" button.
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await sleep(300);
    }

    // No Connect anywhere. As a menu-free fallback, treat a "· 1st" degree
    // badge in the OWNER's top card as the already-connected signal. Scope the
    // scan to the section containing the profile's single <h1> (the owner's
    // name): a profile page's <main> also holds sidebars ("People you may
    // know", "People also viewed", mutual connections) whose cards show OTHER
    // members' "· 1st" badges, so a main-wide scan false-fires on 2nd/3rd-degree
    // profiles.
    if (!connected) {
      connected = await this.page
        .evaluate(() => {
          const h1 = document.querySelector('main h1') ?? document.querySelector('h1');
          const card = h1?.closest('section') ?? h1?.parentElement ?? null;
          if (!card) return false;
          return Array.from(card.querySelectorAll('span, div')).some((e) => {
            const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim();
            return t === '· 1st' || /^1st degree connection$/i.test(t);
          });
        })
        .catch(() => false);
    }

    return { button: null, connected };
  }

  /** Extracts the vanity slug from an /in/<slug> URL. */
  private parseProfileId(href: string): string | undefined {
    const m = href.match(/\/in\/([^/?#]+)/);
    return m?.[1];
  }
}
