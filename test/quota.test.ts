/**
 * Unit tests for the daily action-quota manager. Drives a QuotaManager against
 * a throwaway file path (no Electron / userData), so it runs under ts-node.
 *   npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaManager, QuotaError, nextResetAt } from '../src/driver/quota';

/** A unique quota-file path per manager so tests never share state. */
let seq = 0;
function tempQuotaPath(): string {
  seq += 1;
  return join(tmpdir(), `linkedin-quota-test-${process.pid}-${seq}.json`);
}

test('a fresh quota reports zero usage against the default caps', async () => {
  const q = new QuotaManager(tempQuotaPath());
  const snap = await q.snapshot();
  const find = (action: string): unknown => snap.find((r) => r.action === action);
  assert.deepEqual(find('connection'), { action: 'connection', used: 0, cap: 40 });
  assert.deepEqual(find('message'), { action: 'message', used: 0, cap: 60 });
  assert.deepEqual(find('reaction'), { action: 'reaction', used: 0, cap: 150 });
  assert.deepEqual(find('comment'), { action: 'comment', used: 0, cap: 30 });
});

test('enforce does not throw while under the cap; record increments and persists', async () => {
  const path = tempQuotaPath();
  const q = new QuotaManager(path);
  await q.enforce('message'); // 0 < 60, fine
  await q.record('message');
  await q.record('message');

  const snap = await q.snapshot();
  assert.equal(snap.find((r) => r.action === 'message')?.used, 2);

  // A brand-new manager over the same file must see the persisted count.
  const reopened = new QuotaManager(path);
  const reopenedSnap = await reopened.snapshot();
  assert.equal(reopenedSnap.find((r) => r.action === 'message')?.used, 2);

  await fs.rm(path, { force: true });
});

test('guard runs the action once and records it', async () => {
  const q = new QuotaManager(tempQuotaPath());
  let calls = 0;
  const out = await q.guard('reaction', async () => {
    calls += 1;
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(calls, 1);
  assert.equal((await q.snapshot()).find((r) => r.action === 'reaction')?.used, 1);
});

test('enforce throws QuotaError once the cap is reached', async () => {
  const prev = process.env.LINKEDIN_CAP_CONNECTION;
  process.env.LINKEDIN_CAP_CONNECTION = '2';
  try {
    const q = new QuotaManager(tempQuotaPath());
    await q.record('connection');
    await q.record('connection');
    await assert.rejects(() => q.enforce('connection'), (err: unknown) => {
      assert.ok(err instanceof QuotaError);
      assert.equal(err.action, 'connection');
      assert.equal(err.used, 2);
      assert.equal(err.cap, 2);
      assert.equal(err.code, 'quota_exceeded');
      return true;
    });
    // A different action is unaffected by the connection cap.
    await q.enforce('message');
  } finally {
    if (prev === undefined) delete process.env.LINKEDIN_CAP_CONNECTION;
    else process.env.LINKEDIN_CAP_CONNECTION = prev;
  }
});

test('nextResetAt returns the next local midnight for a mid-day time', () => {
  // 2026-07-14 15:30 local -> resets at 2026-07-15 00:00 local.
  const iso = nextResetAt(new Date(2026, 6, 14, 15, 30, 0));
  assert.equal(new Date(iso).getTime(), new Date(2026, 6, 15, 0, 0, 0, 0).getTime());
});

test('nextResetAt normalizes month and year boundaries', () => {
  // A minute before New Year rolls over into the next year at midnight.
  const iso = nextResetAt(new Date(2026, 11, 31, 23, 59, 0));
  assert.equal(new Date(iso).getTime(), new Date(2027, 0, 1, 0, 0, 0, 0).getTime());
});

test('the quota tool payload carries a resetsAt in the future', () => {
  // The mapped row shape the linkedin_get_quota tool serializes.
  const resetsAt = nextResetAt(new Date(2026, 6, 14, 9, 0, 0));
  const row = { action: 'connection', used: 5, cap: 40, remaining: 35, resetsAt };
  assert.equal(row.resetsAt, resetsAt);
  assert.ok(new Date(resetsAt).getTime() > new Date(2026, 6, 14, 9, 0, 0).getTime());
});

test('an invalid env cap override falls back to the default cap', async () => {
  const prev = process.env.LINKEDIN_CAP_COMMENT;
  process.env.LINKEDIN_CAP_COMMENT = 'not-a-number';
  try {
    const q = new QuotaManager(tempQuotaPath());
    assert.equal((await q.snapshot()).find((r) => r.action === 'comment')?.cap, 30);
  } finally {
    if (prev === undefined) delete process.env.LINKEDIN_CAP_COMMENT;
    else process.env.LINKEDIN_CAP_COMMENT = prev;
  }
});
