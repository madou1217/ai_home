import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApprovalDecisionPayload, ChatRuntimeCommand } from './types';

test('turn submit accepts canonical model and reasoning overrides', () => {
  const command: ChatRuntimeCommand<'turn.submit'> = {
    commandId: 'command-submit',
    sessionId: 'session-1',
    type: 'turn.submit',
    payload: {
      content: 'Implement the plan',
      attachmentIds: ['attachment-1'],
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
    },
  };

  assert.equal(command.payload.model, 'gpt-5.3-codex');
  assert.equal(command.payload.reasoningEffort, 'high');
});

test('approval decisions submit only the adapter-owned canonical choice id', () => {
  const identity = { interactionId: 'approval-1', revision: 1 };
  const once = approvalCommand({ ...identity, choiceId: 'command.once' });

  assert.equal(once.payload.choiceId, 'command.once');

  // @ts-expect-error provider-native decisions never cross the canonical command boundary.
  const nativeDecision: ApprovalDecisionPayload = { ...identity, decision: { kind: 'accept' } };
  void nativeDecision;
});

function approvalCommand(
  payload: ChatRuntimeCommand<'approval.decide'>['payload'],
): ChatRuntimeCommand<'approval.decide'> {
  return { commandId: 'command-1', sessionId: 'session-1', type: 'approval.decide', payload };
}
