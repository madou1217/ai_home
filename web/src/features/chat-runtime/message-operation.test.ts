import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageOperation, branchResultSession, messageOperationAvailable } from './message-operation';
import { SessionRuntimeActions } from './session-runtime-actions';
import type { SessionCommandInput } from '@/chat-runtime';

test('lost branch acknowledgement reuses the command and navigates using server identity', async () => {
  const commands: SessionCommandInput[] = [];
  const operation = new MessageOperation(new SessionRuntimeActions({ dispatch: async (command) => {
    commands.push(command);
    if (commands.length === 1) throw new Error('ack lost');
    return { result: { session: { sessionId: 'child', provider: 'kimi', executionAccountRef: 'account-a',
      policy: { workspaceMode: 'chat', title: '回答 · 重新生成' }, updatedAt: 10 } } };
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

test('Work branch opens its native thread while retaining canonical identity, account and project', () => {
  const response = { result: { session: { sessionId: 'canonical-child', provider: 'codex',
    executionAccountRef: 'account-a', projectPath: '/repo', runtimeBinding: { nativeSessionId: 'native-child' },
    policy: { title: '分支' }, updatedAt: 12 } } };
  assert.deepEqual(branchResultSession(response), { id: 'native-child', runtimeSessionId: 'canonical-child',
    mode: 'work', draft: false, provider: 'codex', accountRef: 'account-a', projectPath: '/repo', title: '分支', updatedAt: 12 });
  assert.throws(() => branchResultSession({ result: { session: { ...response.result.session, runtimeBinding: {} } } }));
});

test('HTTP failure retains branch command identity unless durable state explicitly permits a new command', async () => {
  for (const disposition of [undefined, 'resume', 'new_command']) {
    const commands: SessionCommandInput[] = [];
    const operation = new MessageOperation(new SessionRuntimeActions({ dispatch: async (command) => {
      commands.push(command);
      if (commands.length === 1) throw Object.assign(new Error('fork response unavailable'), { statusCode: 409,
        details: disposition ? { commandRecovery: { commandId: command.commandId, disposition } } : {} });
      return { result: { session: { sessionId: 'child', provider: 'kimi', executionAccountRef: 'a',
        policy: { workspaceMode: 'chat' }, updatedAt: 10 } } };
    } }));
    await assert.rejects(operation.execute('fork', 'answer'));
    await operation.execute('fork', 'answer');
    assert.equal(commands[0].commandId === commands[1].commandId, disposition !== 'new_command');
  }
});

test('message operations follow server capabilities and exclude approval-answer projections', () => {
  const item = { id: 'answer', kind: 'message' as const, status: 'completed' as const, createdAt: 1,
    detail: { role: 'assistant' as const } };
  const catalog = [{ type: 'session.fork' }, { type: 'turn.regenerate' }];
  assert.equal(messageOperationAvailable(catalog, item, 'fork'), true);
  assert.equal(messageOperationAvailable([], item, 'fork'), false);
  assert.equal(messageOperationAvailable(catalog, { ...item, detail: { role: 'user', phase: 'interaction_answer' } }, 'fork'), false);
  assert.equal(messageOperationAvailable(catalog, { ...item, detail: { role: 'user' } }, 'regenerate'), false);
});
