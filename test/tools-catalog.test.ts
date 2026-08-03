/**
 * Unit tests for the MCP tool catalog. Imports tools.ts only — the driver and
 * Electron are required lazily inside handlers, so nothing launches here and it
 * runs under ts-node.
 *   npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodTypeAny } from 'zod';

import {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  conversationThreadId,
} from '../src/mcp/tools';

test('every advertised tool has a handler, and vice versa', () => {
  const advertised = TOOL_DEFINITIONS.map((d) => d.name).sort();
  const handled = Object.keys(TOOL_HANDLERS).sort();
  assert.deepEqual(advertised, handled);
});

test('linkedin_get_messages is advertised with a required conversationId', () => {
  const def = TOOL_DEFINITIONS.find((d) => d.name === 'linkedin_get_messages');
  assert.ok(def, 'linkedin_get_messages should be in the catalog');
  // `inputSchema` is a zod RAW SHAPE, whose index signature is the broad
  // `$ZodType` — narrow to `ZodTypeAny` to reach `safeParse`.
  const shape = def.inputSchema as Record<string, ZodTypeAny | undefined>;
  assert.deepEqual(Object.keys(shape), ['conversationId']);
  const conversationId = shape.conversationId;
  assert.ok(conversationId, 'conversationId should be advertised');
  // Required, so an absent value must fail the SDK-side validation.
  assert.equal(conversationId.safeParse('2-abc==').success, true);
  assert.equal(conversationId.safeParse(undefined).success, false);
  assert.equal(typeof TOOL_HANDLERS.linkedin_get_messages, 'function');
});

test('conversationThreadId accepts a bare id unchanged', () => {
  assert.equal(conversationThreadId('2-NWY4ZTQ5ZDMt'), '2-NWY4ZTQ5ZDMt');
  assert.equal(conversationThreadId('  2-NWY4ZTQ5ZDMt  '), '2-NWY4ZTQ5ZDMt');
});

test('conversationThreadId extracts the id from a thread URL', () => {
  assert.equal(
    conversationThreadId('https://www.linkedin.com/messaging/thread/2-NWY4ZTQ5ZDMt/'),
    '2-NWY4ZTQ5ZDMt',
  );
  // Trailing query/hash and a relative href are both tolerated.
  assert.equal(
    conversationThreadId('/messaging/thread/2-abc==/?filter=unread#top'),
    '2-abc==',
  );
});
