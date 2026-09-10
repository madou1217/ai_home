import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageOperation } from './message-operation';
import { SessionRuntimeActions } from './session-runtime-actions';
import type { SessionCommandInput } from '@/chat-runtime';

test('lost branch acknowledgement reuses the command and navigates using server identity', async () => {
  const commands: SessionCommandInput[] = [];
  const operation = new MessageOperation(new SessionRuntimeActions({ dispatch: async (command) => {
    commands.push(command);
    if (commands.length === 1) throw new Error('ack lost');
    return { result: { session: { sessionId: 'child', provider: 'kimi', executionAccountRef: 'account-a',
      policy: { title: '回答 · 重新生成' }, updatedAt: 10 } } };
  } }));
  await assert.rejects(operation.execute('regenerate', 'answer-1'));
  const session = await operation.execute('regenerate', 'answer-1');
  assert.equal(commands[0].commandId, commands[1].commandId);
  assert.deepEqual(commands[1].payload, { sourceItemId: 'answer-1' });
  assert.equal(session.runtimeSessionId, 'child');
  assert.equal(session.provider, 'kimi');
  assert.equal(session.accountRef, 'account-a');
  await operation.execute('regenerate', 'answer-1');
  assert.notEqual(commands[1].commandId, commands[2].commandId);
});
