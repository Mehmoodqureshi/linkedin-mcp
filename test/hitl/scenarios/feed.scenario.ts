/**
 * HITL scenario: "feed".
 *
 * Exercises the feed action surface end-to-end against the LIVE site, in a
 * headed browser, pausing after every step for a human verdict:
 *
 *   - feed.getFeed(5)            READ-only — home feed; prints author + preview
 *   - feed.getNotifications(10)  READ-only — recent notifications
 *   - feed.likePost(likePostUrl) MUTATING  — gated by the three-layer safety model
 *
 * The scenario is intentionally thin: every step calls back into the Runner
 * (runReadOnly / runMutating) so timing, screenshots, mutation gating and the
 * verdict prompt stay centralized and impossible to bypass per-scenario. The
 * step closures call the REAL driver action and RETURN the raw result — the
 * Runner captures, previews and screenshots it; we never screenshot ourselves.
 *
 * sourceHint on every step points at src/driver/actions/feed.ts so any FAIL the
 * human records routes straight to the file whose selectors/actions to tune.
 */

import type { FeedPost, NotificationItem } from '../../../src/driver/actions/feed';
import type { RunContext, ScenarioCtx, ScenarioModule } from '../types';

const SOURCE_HINT = 'src/driver/actions/feed.ts';

/**
 * Bridge the scenario-facing ScenarioCtx to the RunContext the Runner needs.
 * The orchestrator (index.ts) builds a single context object that satisfies
 * both shapes, so this is a typed narrowing rather than a synthesis of state —
 * the scenario never reaches for the Page, fs or readline directly.
 */
function runCtx(ctx: ScenarioCtx): RunContext {
  return ctx as unknown as RunContext;
}

/**
 * Compact, human-scannable summary of a feed post for the stderr log: author
 * plus a short content preview. (The full result is still captured by the
 * Runner's JSON preview + screenshot; this is just an at-a-glance aid.)
 */
function summarizePosts(posts: FeedPost[]): void {
  process.stderr.write(`  feed: ${posts.length} post(s)\n`);
  posts.forEach((p, i) => {
    const author = p.author ?? '(unknown author)';
    const preview = (p.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 120);
    process.stderr.write(`    [${i}] ${author}: ${preview}\n`);
  });
}

/** Compact summary of notifications: actor/type + short text preview. */
function summarizeNotifications(items: NotificationItem[]): void {
  process.stderr.write(`  notifications: ${items.length} item(s)\n`);
  items.forEach((n, i) => {
    const who = n.actor ?? n.type ?? '(unknown)';
    const mark = n.unread ? '•' : ' ';
    const preview = (n.text ?? '').replace(/\s+/g, ' ').slice(0, 120);
    process.stderr.write(`    [${i}] ${mark} ${who}: ${preview}\n`);
  });
}

const scenario: ScenarioModule = {
  id: 'feed',
  label: 'Feed: read home feed + notifications, like a post (gated)',
  group: 'feed',

  async run(ctx: ScenarioCtx): Promise<void> {
    const rc = runCtx(ctx);
    const { runner, targets } = ctx;

    // --- READ: home feed -------------------------------------------------
    await runner.runReadOnly(
      {
        name: 'feed-getFeed',
        group: 'feed',
        action: 'feed.getFeed',
        inputs: { limit: 5 },
        sourceHint: SOURCE_HINT,
      },
      rc,
      async () => {
        const posts = await ctx.driver.feed.getFeed(5);
        summarizePosts(posts);
        return posts;
      },
    );

    // --- READ: notifications --------------------------------------------
    await runner.runReadOnly(
      {
        name: 'feed-getNotifications',
        group: 'feed',
        action: 'feed.getNotifications',
        inputs: { limit: 10 },
        sourceHint: SOURCE_HINT,
      },
      rc,
      async () => {
        const items = await ctx.driver.feed.getNotifications(10);
        summarizeNotifications(items);
        return items;
      },
    );

    // --- MUTATING: like a post (three-layer safety gate) -----------------
    // Layer 1 is this call site choosing runMutating. Layers 2 (opt-in flag)
    // and 3 (target presence + literal 'yes') are enforced inside the Runner.
    // We still guard each target here so an absent key skips gracefully with a
    // clear note instead of handing the gate an empty target. NOTE: don't
    // `return` early on a missing key — that would silently skip the react and
    // comment steps below; gate each step independently instead.
    const likePostUrl = targets.likePostUrl?.trim();
    if (likePostUrl) {
      await runner.runMutating(
        {
          name: 'feed-likePost',
          group: 'feed',
          action: 'feed.likePost',
          inputs: { postUrl: likePostUrl },
          sourceHint: SOURCE_HINT,
        },
        {
          effect: 'Likes the post at the target URL (adds your Like reaction).',
          target: likePostUrl,
          payload: { postUrl: likePostUrl },
        },
        rc,
        () => ctx.driver.feed.likePost(likePostUrl),
      );
    } else {
      process.stderr.write(
        '  feed.likePost: no likePostUrl configured — skipping.\n',
      );
    }

    // --- MUTATING: react to a post (exercises the reactions flyout) -------
    // Distinct from likePost: a non-'like' reaction drives the hover→pick path
    // in reactToPost, which likePost (a 'like' shortcut) never touches.
    const reactPostUrl = targets.reactTarget?.postUrl?.trim();
    if (reactPostUrl) {
      const reaction = targets.reactTarget?.reaction ?? 'like';
      await runner.runMutating(
        {
          name: 'feed-reactToPost',
          group: 'feed',
          action: 'feed.reactToPost',
          inputs: { postUrl: reactPostUrl, reaction },
          sourceHint: SOURCE_HINT,
        },
        {
          effect: `Adds your "${reaction}" reaction to the post at the target URL.`,
          target: reactPostUrl,
          payload: { postUrl: reactPostUrl, reaction },
        },
        rc,
        () => ctx.driver.feed.reactToPost(reactPostUrl, reaction),
      );
    } else {
      process.stderr.write(
        '  feed.reactToPost: no reactTarget configured — skipping.\n',
      );
    }

    // --- MUTATING: comment on a post -------------------------------------
    const commentPostUrl = targets.commentTarget?.postUrl?.trim();
    const commentText = targets.commentTarget?.text?.trim();
    if (commentPostUrl && commentText) {
      await runner.runMutating(
        {
          name: 'feed-commentOnPost',
          group: 'feed',
          action: 'feed.commentOnPost',
          inputs: { postUrl: commentPostUrl, text: commentText },
          sourceHint: SOURCE_HINT,
        },
        {
          effect: 'Posts a public comment on the post at the target URL.',
          target: commentPostUrl,
          payload: { postUrl: commentPostUrl, text: commentText },
        },
        rc,
        () => ctx.driver.feed.commentOnPost(commentPostUrl, commentText),
      );
    } else {
      process.stderr.write(
        '  feed.commentOnPost: no commentTarget configured — skipping.\n',
      );
    }
  },
};

export default scenario;
