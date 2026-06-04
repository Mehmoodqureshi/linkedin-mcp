/**
 * Feed actions: read the home feed, like a post, and read notifications.
 *
 * The home feed is an infinite, virtualized list. Each post is an
 * `[data-urn]`/`div.feed-shared-update-v2` container that exposes the author,
 * body text, and a social-counts row. We scroll-to-collect up to `limit`
 * normalized posts. Notifications come from `/notifications/`, whose items
 * carry a type, an actor, a timestamp, and a read/unread state.
 */

import type { Page } from 'playwright';

import {
  LINKEDIN_BASE,
  ActionError,
  assertAuthenticated,
  autoScroll,
  clean,
  navigate,
  normalizeProfileUrl,
  rateLimitDelay,
  resolveLinkedInUrl,
  sleep,
} from './common';
import { getQuotaManager } from '../quota';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedPost {
  /** Stable post URN (e.g. urn:li:activity:...), when available. */
  urn?: string;
  author?: string;
  authorHeadline?: string;
  text?: string;
  /** Raw engagement labels as rendered (e.g. "128", "12 comments"). */
  likes?: string;
  comments?: string;
  timestamp?: string;
  postUrl?: string;
}

export interface NotificationItem {
  type?: string;
  actor?: string;
  text?: string;
  timestamp?: string;
  unread: boolean;
  url?: string;
}

export interface MemberPost {
  /** Stable post URN, e.g. urn:li:activity:123. */
  urn: string;
  /** Canonical permalink to the post. */
  postUrl: string;
  /** A short preview of the post body, when extractable. */
  text?: string;
}

/** The six LinkedIn reaction types, keyed by the verb passed to `reactToPost`. */
export type ReactionType =
  | 'like'
  | 'celebrate'
  | 'support'
  | 'love'
  | 'insightful'
  | 'funny';

/**
 * Maps each reaction verb to the accessible name LinkedIn renders on its
 * reaction control (e.g. `aria-label="React Celebrate"`). Used to target the
 * right entry in the reactions flyout.
 */
const REACTION_LABELS: Record<ReactionType, string> = {
  like: 'Like',
  celebrate: 'Celebrate',
  support: 'Support',
  love: 'Love',
  insightful: 'Insightful',
  funny: 'Funny',
};

export interface ReactionResult {
  success: boolean;
  /** The reaction that was applied (or attempted). */
  reaction: ReactionType;
  /**
   * Outcome classification for the caller:
   *  - 'reacted'          the reaction was applied
   *  - 'already_reacted'  the post already carried this member's reaction
   *  - 'unavailable'      no reaction affordance (or the flyout never opened)
   */
  outcome: 'reacted' | 'already_reacted' | 'unavailable';
  message: string;
}

export interface CommentResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// FeedActions
// ---------------------------------------------------------------------------

export class FeedActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // getFeed
  // -------------------------------------------------------------------------

  /** Reads up to `limit` (default 10) normalized posts from the home feed. */
  async getFeed(limit = 10): Promise<FeedPost[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/feed/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await autoScroll(this.page, 'a[href*="/in/"], a[href*="/company/"]', limit).catch(
      () => undefined,
    );

    // Feed posts use obfuscated classes. We detect a post as the smallest
    // container around an author link that ALSO carries the social action bar
    // ("Like" + "Comment") — this excludes sidebar/profile widgets, which have
    // an author link but no action bar. NOTE: LinkedIn often withholds feed
    // posts from automated/headless sessions, in which case this returns [].
    const raw = await this.page.evaluate((cap) => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;
      const isPostText = (t: string): boolean =>
        /\bLike\b/.test(t) && /\bComment\b/.test(t) && t.length > 120 && t.length < 6000;
      // LinkedIn's current React feed ships fully obfuscated class names and NO
      // `data-urn` attributes (verified by DOM probe). The post's activity URN
      // survives only inside anchor hrefs / attribute values, and usually
      // PERCENT-ENCODED, e.g. `...highlightedUpdateUrn=urn%3Ali%3Aactivity%3A123`.
      // So match both `urn:li:activity:<id>` and `urn%3Ali%3Aactivity%3A<id>`.
      const ACTIVITY_RE = /urn(?::|%3A)li(?::|%3A)activity(?::|%3A)(\d+)/i;

      // Find the post's activity id by scanning, NEAREST-first (so we bind to
      // this post's card, not a sibling in a shared list ancestor): the element's
      // own anchors and attributes, then climbing a few levels. Returns a
      // canonical `urn:li:activity:<id>` or '' when the post exposes no permalink
      // (e.g. some company-page posts genuinely have none).
      const findUrn = (start: HTMLElement): string => {
        let node: HTMLElement | null = start;
        for (let depth = 0; depth < 6 && node; depth++) {
          for (const anchor of Array.from(node.querySelectorAll('a[href]'))) {
            const m = (anchor.getAttribute('href') ?? '').match(ACTIVITY_RE);
            if (m) return `urn:li:activity:${m[1]}`;
          }
          for (const at of Array.from(node.attributes)) {
            const m = at.value.match(ACTIVITY_RE);
            if (m) return `urn:li:activity:${m[1]}`;
          }
          node = node.parentElement;
        }
        return '';
      };

      const seen = new Set<Element>();
      const seenUrn = new Set<string>();
      const out: Array<{ urn: string; lines: string[] }> = [];
      for (const a of Array.from(
        root.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'),
      )) {
        let el: HTMLElement | null = a as HTMLElement;
        for (let i = 0; i < 12 && el; i++) {
          if (isPostText(el.innerText ?? '')) break;
          el = el.parentElement;
        }
        if (!el || seen.has(el) || !isPostText(el.innerText ?? '')) continue;
        seen.add(el);
        const urn = findUrn(el);
        // Collapse the nested containers of a single post (the source of the
        // earlier 3x-duplicate output): once we've emitted a URN, skip it.
        if (urn && seenUrn.has(urn)) continue;
        if (urn) seenUrn.add(urn);
        const stop = new Set<string>();
        const lines = (el.innerText ?? '')
          .split('\n')
          .map(norm)
          .filter((t) => {
            if (!t || stop.has(t)) return false;
            stop.add(t);
            return true;
          });
        out.push({ urn, lines });
        if (out.length >= cap) break;
      }
      return out;
    }, limit);

    const out: FeedPost[] = [];
    const ACTION_RE =
      /^(like|comment|repost|send|follow|likes?|comments?|reposts?)$/i;
    const TIME_RE = /(•|·)?\s*\d+\s*(m|h|d|w|mo|y|hour|day|week|month|year)s?\b|ago/i;
    // Label/affordance lines LinkedIn injects above/around the real author.
    const LABEL_RE =
      /^(feed post|suggested|promoted|sponsored|start a post|photo|video|write article|media)$|^sort by\b|(reposted|likes? this|loves this|finds this|celebrates|supports this|commented on|follows?)\b|follow this page$|other connections? follow/i;
    const DEGREE_RE = /^•?\s*(1st|2nd|3rd)\+?$/i;
    for (const r of raw) {
      const post: FeedPost = {};
      if (r.urn) {
        post.urn = r.urn;
        const activity = r.urn.match(/urn:li:activity:(\d+)/)?.[1];
        if (activity) {
          post.postUrl = `${LINKEDIN_BASE}/feed/update/urn:li:activity:${activity}/`;
        }
      }
      // Drop label + degree lines so the author is the first real name line.
      const named = r.lines.filter(
        (l) => !LABEL_RE.test(l) && !DEGREE_RE.test(l),
      );
      const author = clean(named[0]);
      if (author) post.author = author;
      const headline = clean(named[1]);
      if (headline && !TIME_RE.test(headline)) post.authorHeadline = headline;
      const timestamp = clean(named.find((l) => TIME_RE.test(l)));
      if (timestamp) post.timestamp = timestamp;
      // Body text: the longest line that isn't author/headline/action/time.
      const body = clean(
        named
          .filter(
            (l) =>
              !ACTION_RE.test(l) &&
              !TIME_RE.test(l) &&
              l !== author &&
              l !== headline,
          )
          .sort((a, b) => b.length - a.length)[0],
      );
      if (body) post.text = body;
      if (post.author || post.text) out.push(post);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // getMemberPosts
  // -------------------------------------------------------------------------

  /**
   * Reads a member's recent activity and returns their post permalinks (newest
   * first), so a specific member's post can be located without waiting for it to
   * surface in the volatile home feed. Navigates to `/in/<slug>/recent-activity/
   * all/` and scans for activity URNs in anchor hrefs (the current React feed
   * exposes them only there, often percent-encoded — see getFeed's findUrn).
   */
  async getMemberPosts(profileUrl: string, limit = 5): Promise<MemberPost[]> {
    const canonical = normalizeProfileUrl(profileUrl);
    const base = canonical.replace(/\/+$/, '');
    await navigate(this.page, `${base}/recent-activity/all/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await autoScroll(this.page, '[data-urn*="urn:li:activity:"]', limit).catch(
      () => undefined,
    );

    // The recent-activity page (unlike the new React home feed) keeps the
    // classic `<div data-urn="urn:li:activity:<id>">` post container, verified by
    // DOM probe. Read the URN straight off those, newest first.
    const raw = await this.page.evaluate((cap: number) => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;
      const seen = new Set<string>();
      const out: Array<{ id: string; text: string }> = [];
      for (const el of Array.from(
        root.querySelectorAll('[data-urn*="urn:li:activity:"]'),
      )) {
        const m = (el.getAttribute('data-urn') ?? '').match(/urn:li:activity:(\d+)/);
        if (!m) continue;
        const id = m[1] ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          text: norm((el as HTMLElement).innerText).slice(0, 600),
        });
        if (out.length >= cap) break;
      }
      return out;
    }, limit);

    return raw.map((r) => {
      const post: MemberPost = {
        urn: `urn:li:activity:${r.id}`,
        postUrl: `${LINKEDIN_BASE}/feed/update/urn:li:activity:${r.id}/`,
      };
      const text = clean(r.text);
      if (text) post.text = text;
      return post;
    });
  }

  // -------------------------------------------------------------------------
  // reactToPost
  // -------------------------------------------------------------------------

  /**
   * Reacts to a single post by URL with one of LinkedIn's six reactions.
   *
   * Navigates to the post's permalink and locates its reaction control (the
   * "Like" trigger, identified by accessible name). A plain `like` clicks the
   * trigger directly; every other reaction lives behind the reactions flyout,
   * which LinkedIn reveals on hover — we hover the trigger, wait for the picker
   * to animate in, then click the specific reaction by its accessible name.
   *
   * No-ops cleanly (`already_reacted`) when the post already carries this
   * member's reaction, and returns `unavailable` when no reaction affordance is
   * present or the flyout fails to open (a common headless-session quirk).
   */
  async reactToPost(
    postUrl: string,
    reaction: ReactionType = 'like',
  ): Promise<ReactionResult> {
    // Fail fast if we're already at today's reaction cap (before any navigation).
    await getQuotaManager().enforce('reaction');

    const url = resolveLinkedInUrl(postUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const label = REACTION_LABELS[reaction];

    // The post's primary reaction button, in ANY state — unreacted ("Like" /
    // "React Like") or already reacted ("Unreact <Reaction>", aria-pressed=true,
    // verified by DOM probe). Exclude comment-scoped reaction controls, whose
    // accessible name is "React Like to <name>'s comment".
    const triggerSel =
      'button[aria-label="Like"]:not([aria-label*="comment" i]), ' +
      'button[aria-label="React Like"]:not([aria-label*="comment" i]), ' +
      'button[aria-label^="React "]:not([aria-label*="comment" i]), ' +
      'button[aria-label^="Unreact "]:not([aria-label*="comment" i])';
    const trigger = this.page.locator(triggerSel).first();

    if ((await trigger.count()) === 0) {
      return {
        success: false,
        reaction,
        outcome: 'unavailable',
        message: 'No reaction control found for this post.',
      };
    }

    // Already reacted? The button reads "Unreact <Reaction>" / aria-pressed=true.
    // (The old code only matched a "Like"-labelled trigger, so an already-reacted
    // post wrongly reported "unavailable".)
    const curLabel = (await trigger.getAttribute('aria-label').catch(() => '')) ?? '';
    const curPressed = await trigger.getAttribute('aria-pressed').catch(() => null);
    if (/^unreact/i.test(curLabel) || curPressed === 'true') {
      const existing = curLabel.replace(/^unreact\s+/i, '').trim() || 'a reaction';
      return {
        success: true,
        reaction,
        outcome: 'already_reacted',
        message: new RegExp(`unreact\\s+${label}\\b`, 'i').test(curLabel)
          ? `Post already carries the ${label} reaction.`
          : `Post already carries a different reaction (${existing}); left unchanged.`,
      };
    }

    await rateLimitDelay();

    // Apply: 'like' is a direct click; the others live behind the hover flyout.
    if (reaction === 'like') {
      await trigger.click().catch(() => undefined);
    } else {
      await trigger.hover().catch(() => undefined);
      await sleep(900); // let the reactions picker animate in
      const pick = this.page
        .locator(
          `button[aria-label="React ${label}"], ` +
            `button[aria-label="${label}"]:not([aria-label*="comment" i]), ` +
            `div[role="menu"] button[aria-label*="${label}" i]`,
        )
        .first();
      if (
        (await pick.count()) === 0 ||
        !(await pick.isVisible().catch(() => false))
      ) {
        return {
          success: false,
          reaction,
          outcome: 'unavailable',
          message: `The "${reaction}" reaction picker did not open for this post.`,
        };
      }
      await pick.click().catch(() => undefined);
    }
    await sleep(1300);

    // VERIFY the reaction actually applied: the post's button must now read
    // "Unreact <label>". Re-locate (its label just changed) and confirm —
    // otherwise report failure rather than the previous unconditional success.
    const afterLabel =
      (await this.page
        .locator('button[aria-label^="Unreact "]:not([aria-label*="comment" i])')
        .first()
        .getAttribute('aria-label')
        .catch(() => '')) ?? '';
    if (!new RegExp(`unreact\\s+${label}\\b`, 'i').test(afterLabel)) {
      return {
        success: false,
        reaction,
        outcome: 'unavailable',
        message: `Reaction did not register (control shows "${afterLabel || 'unknown'}").`,
      };
    }

    // Count the reaction only once it verifiably applied.
    await getQuotaManager().record('reaction');

    return {
      success: true,
      reaction,
      outcome: 'reacted',
      message: `Reacted with ${label}.`,
    };
  }

  // -------------------------------------------------------------------------
  // likePost
  // -------------------------------------------------------------------------

  /**
   * Likes a single post by URL. Thin wrapper over {@link reactToPost} with the
   * `like` reaction, preserved for callers (and HITL scenarios) that only want
   * the simple like path.
   */
  async likePost(postUrl: string): Promise<{ success: boolean; message: string }> {
    const result = await this.reactToPost(postUrl, 'like');
    return { success: result.success, message: result.message };
  }

  // -------------------------------------------------------------------------
  // commentOnPost
  // -------------------------------------------------------------------------

  /**
   * Posts a comment on a single post by URL. Navigates to the permalink, clicks
   * the "Comment" affordance to reveal the composer (a Quill contenteditable),
   * types the body, and submits.
   *
   * Mirrors the messaging composer's resilience: the editor is scrolled into
   * view and force-focused, `fill()` falls back to keyboard typing on a
   * read-only contenteditable, and the submit click falls back to a keyboard
   * shortcut. Throws `ActionError` with a stable code when the post is not
   * commentable or the composer/submit control cannot be found.
   */
  async commentOnPost(postUrl: string, text: string): Promise<CommentResult> {
    // Fail fast if we're already at today's comment cap (before any navigation).
    await getQuotaManager().enforce('comment');

    const url = resolveLinkedInUrl(postUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // The comment composer is a Quill editor (role=textbox, class `ql-editor`,
    // accessible name "Text editor for creating content" — verified by DOM
    // probe). On a post permalink it is usually present already; if not, the
    // "Comment" action button reveals it.
    let editor = this.page.locator('div.ql-editor[contenteditable="true"]').first();
    if ((await editor.count()) === 0) {
      const commentBtn = this.page
        .locator('button[aria-label="Comment"], button[aria-label*="Comment" i]')
        .first();
      if ((await commentBtn.count()) > 0) {
        await commentBtn.click().catch(() => undefined);
        await sleep(1200);
      }
      editor = this.page.locator('div.ql-editor[contenteditable="true"]').first();
    }
    if ((await editor.count()) === 0) {
      throw new ActionError('Comment composer did not open.', 'composer_missing');
    }

    // Type with REAL keystrokes. `fill()` does NOT update Quill's internal model,
    // so it posts an empty comment — keyboard input is required.
    await editor.scrollIntoViewIfNeeded().catch(() => undefined);
    await editor.click({ force: true }).catch(() => undefined);
    await this.page.keyboard.type(text, { delay: 20 });
    await sleep(700);

    // Confirm the text actually registered in the editor before submitting.
    const typed = await editor.innerText().catch(() => '');
    if (!typed.replace(/\s+/g, ' ').includes(text.slice(0, 24).replace(/\s+/g, ' '))) {
      throw new ActionError(
        'Comment text did not register in the composer.',
        'compose_failed',
      );
    }

    // Submit. Target the comment-box submit button by its STABLE class — never
    // `:has-text("Post")`, which substring-matches the "Repost" button (and that
    // sits earlier in the DOM, so `.first()` would click the wrong control).
    await rateLimitDelay();
    const submit = this.page
      .locator(
        'button.comments-comment-box__submit-button--cr, ' +
          'button.comments-comment-box__submit-button, ' +
          'button[aria-label="Post comment"]',
      )
      .first();
    if ((await submit.count()) === 0) {
      throw new ActionError('Comment submit button not found.', 'submit_missing');
    }
    await submit.scrollIntoViewIfNeeded().catch(() => undefined);
    await submit.click({ force: true }).catch(() => undefined);
    await sleep(1800);

    // VERIFY: LinkedIn clears the composer on a successful post. If the editor
    // still holds our text, the comment did NOT post — report that honestly
    // instead of a false success (the original bug).
    const remaining = await editor.innerText().catch(() => '');
    const cleared = remaining.trim().length === 0;
    if (!cleared) {
      return {
        success: false,
        message:
          'Comment may not have posted — the composer still contains text.',
      };
    }

    // Count the comment only once it verifiably posted.
    await getQuotaManager().record('comment');

    return { success: true, message: 'Comment posted.' };
  }

  // -------------------------------------------------------------------------
  // getNotifications
  // -------------------------------------------------------------------------

  /** Reads recent notifications, normalized with type/actor/timestamp/state. */
  async getNotifications(limit = 20): Promise<NotificationItem[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/notifications/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await autoScroll(this.page, 'main article', limit).catch(() => undefined);

    // Notifications render as <article> blocks whose visible text is:
    //   ["Unread notification." | "Read notification.", <content>, <time-ago>]
    // Classes are obfuscated, so we parse the text lines and dedupe by content.
    const raw = await this.page.evaluate((cap) => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;
      const arts = Array.from(root.querySelectorAll('article'));
      const TIME_RE = /^\d+\s*(m|h|d|w|mo|y|min|hour|day|week|month|year)s?$|ago$/i;
      const out: Array<{ lines: string[]; href: string; timeIdx: number }> = [];
      for (const a of arts) {
        const seen = new Set<string>();
        const lines = (a.innerText ?? '')
          .split('\n')
          .map(norm)
          .filter((t) => {
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
          });
        if (!lines.length) continue;
        const href = a.querySelector('a[href]')?.getAttribute('href') ?? '';
        out.push({
          lines,
          href,
          timeIdx: lines.findIndex((l) => TIME_RE.test(l)),
        });
        if (out.length >= cap * 2) break;
      }
      return out;
    }, limit);

    const out: NotificationItem[] = [];
    const seenText = new Set<string>();
    for (const r of raw) {
      const unread = r.lines.some((l) => /^unread notification/i.test(l));
      const timestamp = r.timeIdx >= 0 ? clean(r.lines[r.timeIdx]) : undefined;
      const text = clean(
        r.lines
          .filter(
            (l) =>
              !/^(unread|read) notification/i.test(l) && l !== (timestamp ?? ''),
          )
          .join(' '),
      );
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      const item: NotificationItem = {
        unread,
        type: this.classifyNotification(text),
      };
      item.text = text;
      if (timestamp) item.timestamp = timestamp;
      if (r.href) {
        item.url = r.href.startsWith('http')
          ? r.href
          : `${LINKEDIN_BASE}${r.href}`;
      }
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Heuristically classifies a notification by keywords in its text. */
  private classifyNotification(text?: string): string {
    if (!text) return 'other';
    const t = text.toLowerCase();
    if (t.includes('reacted') || t.includes('liked') || t.includes('likes')) return 'reaction';
    if (t.includes('commented') || t.includes('comment')) return 'comment';
    if (t.includes('mention')) return 'mention';
    if (t.includes('connection') || t.includes('accepted') || t.includes('invitation'))
      return 'connection';
    if (t.includes('job') || t.includes('hiring')) return 'job';
    if (t.includes('viewed') || t.includes('appeared in')) return 'profile_view';
    if (t.includes('posted') || t.includes('shared')) return 'post';
    if (t.includes('birthday') || t.includes('anniversary') || t.includes('congratulate'))
      return 'milestone';
    return 'other';
  }
}
