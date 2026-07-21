import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account } from '@/types';
import {
  buildInitialRunMessages,
  buildStatelessRequestMessages,
  finalizePendingAssistantFailure,
  removePendingAssistant,
  usesNativeSession,
} from './legacy-run-message-policy';

test('run message policy keeps pending UI state out of stateless requests', () => {
  const messages = buildInitialRunMessages([], ' hello ', ['image.png'], {
    clock: () => 10,
    model: 'gpt-5.6-sol',
  });
  assert.deepEqual(messages, [
    {
      role: 'user', content: 'hello', images: ['image.png'], timestamp: 10,
      model: 'gpt-5.6-sol',
    },
    {
      role: 'assistant', content: '', images: [], pending: true,
      statusText: '已发送，正在连接...', timestamp: 10, model: 'gpt-5.6-sol',
    },
  ]);
  assert.deepEqual(buildStatelessRequestMessages(messages), [
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(removePendingAssistant(messages), [messages[0]]);
});

test('run message policy turns an exhausted retry into a visible assistant failure', () => {
  const messages = buildInitialRunMessages([], 'hello', [], { clock: () => 10 });
  const failed = finalizePendingAssistantFailure(messages, '余额不足', () => 20);

  assert.deepEqual(failed.at(-1), {
    role: 'assistant',
    content: '请求失败：余额不足',
    pending: false,
    statusText: undefined,
    timestamp: 10,
    images: [],
  });
});

test('run message policy selects native sessions only for OAuth CLI accounts', () => {
  const account = {
    provider: 'claude', accountRef: 'account-1', configured: true, apiKeyMode: false,
    status: 'up', displayName: 'Claude', remainingPct: null, updatedAt: 1,
  } as Account;
  assert.equal(usesNativeSession(account), true);
  assert.equal(usesNativeSession({ ...account, apiKeyMode: true }), false);
  assert.equal(usesNativeSession({ ...account, provider: 'agy' }), false);
});
