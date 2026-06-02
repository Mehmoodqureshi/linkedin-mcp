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
  assertAuthenticated,
  autoScroll,
  clean,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';

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
      const seen = new Set<Element>();
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
        const urn =
          el.getAttribute('data-urn') ??
          el.getAttribute('data-id') ??
          el.querySelector('[data-urn]')?.getAttribute('data-urn') ??
          '';
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
      /^(feed post|suggested|promoted|sponsored|start a post|photo|video|write article|media)$|(reposted|likes? this|loves this|finds this|celebrates|supports this|commented on|follows?)\b|follow this page$|other connections? follow/i;
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
  // likePost
  // -------------------------------------------------------------------------

  /**
   * Likes a single post by URL. Navigates to the post's permalink and clicks
   * its "Like" reaction button (identified by accessible name). No-ops cleanly
   * if the post is already liked.
   */
  async likePost(postUrl: string): Promise<{ success: boolean; message: string }> {
    const url = postUrl.startsWith('http') ? postUrl : `${LINKEDIN_BASE}${postUrl}`;
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const likeBtn = this.page
      .locator(
        'button[aria-label="React Like"], ' +
          'button[aria-label="Like"], ' +
          'button.react-button__trigger[aria-label*="Like" i]',
      )
      .first();

    if ((await likeBtn.count()) === 0) {
      return { success: false, message: 'No Like button found for this post.' };
    }

    const pressed = await likeBtn.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') {
      return { success: true, message: 'Post was already liked.' };
    }

    await rateLimitDelay();
    await likeBtn.click();
    await sleep(800);
    return { success: true, message: 'Post liked.' };
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
