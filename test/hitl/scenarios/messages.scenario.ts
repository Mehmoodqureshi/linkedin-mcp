/**
 * HITL scenario: messages.
 *
 * Exercises the messaging action surface (src/driver/actions/messages.ts):
 *
 *   - messages.getConversations()            READ-only  — list inbox threads.
 *   - messages.getMessages(conversationId)   READ-only  — read one thread
 *                                                          (skipped if no
 *                                                          conversationId target).
 *   - messages.sendMessage(profileUrl, body) MUTATING   — gated; the confirm
 *                                                          block prints the exact
 *                                                          recipient + message
 *                                                          text before sending.
 *
 * Read-only steps never gate. The single mutating step is routed through
 * `runner.runMutating` with a MutationPlan carrying the exact target + payload,
 * so it can fire only when --include-mutating is set AND the human types 'yes'
 * against the pre-approved `messageTarget` from test-targets.json. If
 * `messageTarget.profileUrl` is empty the plan's `target` is empty and the
 * Runner records the step as a skip ("no safe target configured") without ever
 * calling the action.
 */

import type { ScenarioCtx, ScenarioModule } from '../types';

const GROUP = 'messages' as const;
const SOURCE_HINT = 'src/driver/actions/messages.ts';

const scenario: ScenarioModule = {
  id: 'messages',
  label: 'Messaging — list conversations, read a thread, send a message (gated)',
  group: GROUP,

  async run(ctx: ScenarioCtx): Promise<void> {
    const { driver, targets, runner, rc } = ctx;

    // --- READ: list inbox conversations -----------------------------------
    await runner.runReadOnly(
      {
        name: 'messages-getConversations',
        group: GROUP,
        action: 'messages.getConversations',
        inputs: {},
        sourceHint: SOURCE_HINT,
      },
      rc,
      () => driver.messages.getConversations(),
    );

    // --- READ: read one thread (only when a conversationId is configured) --
    const conversationId = targets.conversationId;
    if (conversationId && conversationId.trim().length > 0) {
      await runner.runReadOnly(
        {
          name: 'messages-getMessages',
          group: GROUP,
          action: 'messages.getMessages',
          inputs: { conversationId },
          sourceHint: SOURCE_HINT,
        },
        rc,
        () => driver.messages.getMessages(conversationId),
      );
    } else {
      // Record a skip so the report shows the step was intentionally not run,
      // rather than silently omitting it. Modelled as a mutating-style no-op:
      // an empty target makes the Runner record 'no safe target configured'.
      // We instead surface it as a read skip via an empty exec guarded above —
      // here we simply leave a breadcrumb on stderr (the Runner owns reporting).
      process.stderr.write(
        '[hitl] messages.getMessages skipped: no conversationId in test-targets.json\n',
      );
    }

    // --- MUTATING: send a direct message ----------------------------------
    // Target + body come ONLY from the dedicated `messageTarget` config key.
    const messageTarget = targets.messageTarget;
    const recipient = messageTarget?.profileUrl ?? '';
    const body = messageTarget?.body ?? '';

    await runner.runMutating(
      {
        name: 'messages-sendMessage',
        group: GROUP,
        action: 'messages.sendMessage',
        inputs: { profileUrl: recipient, message: body },
        sourceHint: SOURCE_HINT,
      },
      {
        // `target` empty -> Runner records 'no safe target configured' and the
        // action is never invoked. Otherwise the confirm-gate prints exactly
        // this recipient and message body before any send fires.
        target: recipient,
        effect: 'Sends a direct LinkedIn message to the recipient above.',
        payload: { message: body },
      },
      rc,
      () => driver.messages.sendMessage(recipient, body),
    );
  },
};

export default scenario;
