/**
 * Unit tests for the deny-by-default write-action gate. Imports only the
 * dependency-free gate module (no driver/Electron), so it runs under ts-node.
 *   npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMutatingTool, mutationAllowed, MUTATING_TOOLS } from '../src/mcp/mutation-gate';

test('the account-action tools are classified as mutating', () => {
  for (const t of [
    'linkedin_send_message',
    'linkedin_send_connection',
    'linkedin_accept_invitation',
    'linkedin_withdraw_invitation',
    'linkedin_react',
    'linkedin_comment',
  ]) {
    assert.equal(isMutatingTool(t), true, `${t} should be mutating`);
  }
});

test('read tools are NOT mutating', () => {
  for (const t of ['linkedin_get_profile', 'linkedin_search_people', 'linkedin_get_feed', 'linkedin_status']) {
    assert.equal(isMutatingTool(t), false, `${t} should not be mutating`);
  }
});

test('deny-by-default: no allowlist means every write action is blocked', () => {
  for (const t of MUTATING_TOOLS) {
    assert.equal(mutationAllowed(t, undefined), false);
    assert.equal(mutationAllowed(t, ''), false);
    assert.equal(mutationAllowed(t, '   '), false);
  }
});

test('allowlist enables only the listed tools (prefix-insensitive)', () => {
  assert.equal(mutationAllowed('linkedin_send_message', 'send_message,react'), true);
  assert.equal(mutationAllowed('linkedin_react', 'send_message,react'), true);
  assert.equal(mutationAllowed('linkedin_send_connection', 'send_message,react'), false);
  // full names also accepted
  assert.equal(mutationAllowed('linkedin_comment', 'linkedin_comment'), true);
  // whitespace tolerated
  assert.equal(mutationAllowed('linkedin_send_message', '  send_message ,  react '), true);
});

test('"all" / "*" wildcard enables every write action', () => {
  for (const t of MUTATING_TOOLS) {
    assert.equal(mutationAllowed(t, 'all'), true);
    assert.equal(mutationAllowed(t, '*'), true);
  }
});

test('an unrelated allowlist entry does not enable a different tool', () => {
  assert.equal(mutationAllowed('linkedin_send_message', 'react'), false);
});
