/**
 * The tool surface additions: the real package version in the handshake, typed
 * error codes in the error envelope, `dryRun` on the mutating tools, and `limit`
 * on the search/inbox reads.
 *
 * None of these need a browser or a LinkedIn session: the mutation gate and the
 * error firewall both run before any handler launches Chrome.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';

import { dispatchToolCall, TOOL_DEFINITIONS } from '../src/mcp/tools';
import { SERVER_VERSION } from '../src/mcp/server';
import { isMutatingTool, mutationAllowed } from '../src/mcp/mutation-gate';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from '../src/driver/actions/search';
import { answerKey, normalizeJobUrl } from '../src/driver/actions/apply';

function definition(name: string): (typeof TOOL_DEFINITIONS)[number] {
  const def = TOOL_DEFINITIONS.find((d) => d.name === name);
  assert.ok(def, `tool "${name}" is not advertised`);
  return def;
}

function field(tool: string, key: string): ZodTypeAny {
  const shape = definition(tool).inputSchema as Record<string, ZodTypeAny | undefined>;
  const f = shape[key];
  assert.ok(f, `tool "${tool}" does not advertise "${key}"`);
  return f;
}

/** Parse the envelope a dispatch error renders into. */
function errorPayload(r: { content: Array<{ type: 'text'; text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

// --- Handshake version -----------------------------------------------------

test('the MCP handshake reports the real package version, not a hardcoded 1.0.0', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(SERVER_VERSION, pkg.version);
  assert.notEqual(SERVER_VERSION, '1.0.0');
});

// --- Typed error codes -----------------------------------------------------

test('a denied mutation carries a machine-readable code and a recovery hint', async () => {
  const previous = process.env.LINKEDIN_ALLOW_MUTATIONS;
  delete process.env.LINKEDIN_ALLOW_MUTATIONS;
  try {
    const r = await dispatchToolCall('linkedin_send_message', {
      profileUrl: 'https://www.linkedin.com/in/someone',
      message: 'hi',
    });
    assert.equal(r.isError, true);
    const payload = errorPayload(r);
    assert.equal(payload.tool, 'linkedin_send_message');
    assert.equal(payload.code, 'mutations_disabled');
    assert.match(String(payload.recovery), /LINKEDIN_ALLOW_MUTATIONS/);
    // The human-readable message is still there — the code is additive.
    assert.match(String(payload.error), /disabled by default/);
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_ALLOW_MUTATIONS;
    else process.env.LINKEDIN_ALLOW_MUTATIONS = previous;
  }
});

test('an error with no known code carries no code field', async () => {
  const r = await dispatchToolCall('linkedin_no_such_tool', {});
  assert.equal(r.isError, true);
  const payload = errorPayload(r);
  assert.equal(payload.code, undefined);
  assert.equal(payload.recovery, undefined);
  assert.match(String(payload.error), /Unknown tool/);
});

// --- dryRun ----------------------------------------------------------------

const MUTATING_TOOLS = [
  'linkedin_send_message',
  'linkedin_send_connection',
  'linkedin_react',
  'linkedin_comment',
  'linkedin_accept_invitation',
  'linkedin_withdraw_invitation',
];

test('every mutating tool advertises dryRun', () => {
  for (const tool of MUTATING_TOOLS) {
    const f = field(tool, 'dryRun');
    assert.equal(f.safeParse(true).success, true, `${tool}.dryRun rejected a boolean`);
    assert.equal(f.safeParse(undefined).success, true, `${tool}.dryRun is not optional`);
    assert.equal(f.safeParse('yes').success, false, `${tool}.dryRun accepted a string`);
  }
});

test('a dryRun previews the payload without the mutation gate, a browser, or a write', async () => {
  const previous = process.env.LINKEDIN_ALLOW_MUTATIONS;
  delete process.env.LINKEDIN_ALLOW_MUTATIONS;
  try {
    // Mutations are OFF: the same call without dryRun is refused by the gate
    // (asserted below). The preview needs nothing from the browser, so it
    // resolves entirely in-process.
    const r = await dispatchToolCall('linkedin_react', {
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      reaction: 'celebrate',
      dryRun: true,
    });
    assert.notEqual(r.isError, true, `dryRun errored: ${r.content[0]?.text}`);
    const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.equal(payload.dryRun, true);
    assert.equal(payload.performed, false);
    assert.equal(payload.quotaCharged, false);
    assert.deepEqual(payload.wouldSend, {
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      reaction: 'celebrate',
    });
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_ALLOW_MUTATIONS;
    else process.env.LINKEDIN_ALLOW_MUTATIONS = previous;
  }
});

test('a dryRun comment previews the exact comment body', async () => {
  const r = await dispatchToolCall('linkedin_comment', {
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:2/',
    text: 'Congratulations!',
    dryRun: true,
  });
  assert.notEqual(r.isError, true);
  const payload = JSON.parse(r.content[0]!.text) as { wouldSend: { comment: string } };
  assert.equal(payload.wouldSend.comment, 'Congratulations!');
});

test('the same call without dryRun is still refused while mutations are off', async () => {
  const previous = process.env.LINKEDIN_ALLOW_MUTATIONS;
  delete process.env.LINKEDIN_ALLOW_MUTATIONS;
  try {
    const r = await dispatchToolCall('linkedin_react', {
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      reaction: 'celebrate',
    });
    assert.equal(r.isError, true);
    assert.equal(errorPayload(r).code, 'mutations_disabled');
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_ALLOW_MUTATIONS;
    else process.env.LINKEDIN_ALLOW_MUTATIONS = previous;
  }
});

// --- linkedin_apply ---------------------------------------------------------

test('linkedin_apply is advertised, gated as a write, and takes answers + dryRun', () => {
  const def = definition('linkedin_apply');
  assert.match(def.description, /dryRun/);
  assert.match(def.description, /NEVER guesses/i);
  assert.ok(isMutatingTool('linkedin_apply'), 'apply must be behind the mutation gate');
  assert.equal(mutationAllowed('linkedin_apply', undefined), false, 'must be denied by default');
  assert.equal(mutationAllowed('linkedin_apply', 'apply'), true);

  assert.equal(field('linkedin_apply', 'jobUrl').safeParse('4444995257').success, true);
  assert.equal(field('linkedin_apply', 'dryRun').safeParse(true).success, true);
  const answers = field('linkedin_apply', 'answers');
  assert.equal(answers.safeParse({ 'Years of experience': '6' }).success, true);
  assert.equal(answers.safeParse({ 'Years of experience': 6 }).success, false, 'answers must be strings');
  assert.equal(answers.safeParse(undefined).success, true);
});

test('an apply without dryRun is refused while mutations are off', async () => {
  const previous = process.env.LINKEDIN_ALLOW_MUTATIONS;
  delete process.env.LINKEDIN_ALLOW_MUTATIONS;
  try {
    const r = await dispatchToolCall('linkedin_apply', { jobUrl: '4444995257' });
    assert.equal(r.isError, true);
    assert.equal(errorPayload(r).code, 'mutations_disabled');
  } finally {
    if (previous === undefined) delete process.env.LINKEDIN_ALLOW_MUTATIONS;
    else process.env.LINKEDIN_ALLOW_MUTATIONS = previous;
  }
});

test('normalizeJobUrl accepts an id, a job URL, and a search URL', () => {
  const expected = 'https://www.linkedin.com/jobs/view/4444995257';
  assert.equal(normalizeJobUrl('4444995257'), expected);
  assert.equal(normalizeJobUrl('https://www.linkedin.com/jobs/view/4444995257'), expected);
  assert.equal(normalizeJobUrl('https://www.linkedin.com/jobs/view/4444995257/?refId=abc'), expected);
  assert.equal(normalizeJobUrl('https://www.linkedin.com/jobs/search/?currentJobId=4444995257&f_WT=2'), expected);
  assert.throws(() => normalizeJobUrl('https://example.com/careers'), /does not name a LinkedIn job/);
});

test('answerKey matching ignores case, spacing, punctuation and the required marker', () => {
  const canonical = answerKey('Years of experience');
  assert.equal(answerKey('  years   of  experience  '), canonical);
  assert.equal(answerKey('Years of experience?'), canonical);
  assert.equal(answerKey('Years of experience:'), canonical);
  assert.equal(answerKey('YEARS OF EXPERIENCE'), canonical);
  assert.notEqual(answerKey('Years of experience with React'), canonical);
});

// --- limit on the search/inbox reads ---------------------------------------

test('the search tools and the inbox advertise a bounded limit', () => {
  for (const tool of [
    'linkedin_search_people',
    'linkedin_search_jobs',
    'linkedin_search_companies',
    'linkedin_get_conversations',
  ]) {
    const f = field(tool, 'limit');
    assert.equal(f.safeParse(5).success, true, `${tool}.limit rejected 5`);
    assert.equal(f.safeParse(MAX_RESULT_LIMIT).success, true, `${tool}.limit rejected its own max`);
    assert.equal(f.safeParse(MAX_RESULT_LIMIT + 1).success, false, `${tool}.limit accepted an over-max value`);
    assert.equal(f.safeParse(0).success, false, `${tool}.limit accepted 0`);
    assert.equal(f.safeParse(2.5).success, false, `${tool}.limit accepted a fraction`);
    assert.equal(f.safeParse(undefined).success, true, `${tool}.limit is not optional`);
  }
});

test('the advertised bounds bracket the driver default', () => {
  assert.equal(DEFAULT_RESULT_LIMIT, 25);
  assert.ok(
    DEFAULT_RESULT_LIMIT <= MAX_RESULT_LIMIT,
    'the default result count must be reachable within the advertised maximum',
  );
  // The old hardcoded page size, now the default — a caller can go both below
  // and above it, which was the whole point of adding the parameter.
  const f = field('linkedin_search_people', 'limit');
  assert.equal(f.safeParse(DEFAULT_RESULT_LIMIT - 20).success, true);
  assert.equal(f.safeParse(DEFAULT_RESULT_LIMIT + 15).success, true);
});
