import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntimeSession } from '@/chat-runtime';
import { resolveBranchParentHref } from './branch-navigation';

test('Work parent navigation resolves exact canonical identity and opens the native project route', async () => {
  const target = { provider: 'codex', executionAccountRef: 'a', projectPath: '/repo with space',
    policy: { approvalMode: 'confirm' as const } };
  const session: ChatRuntimeSession = { ...target, sessionId: 'parent', state: 'idle', createdAt: 1,
    updatedAt: 1, lastEventSeq: 1, runtimeBinding: { nativeSessionId: 'native-parent' }, capabilitySnapshot: {} };
  const api = { resolveSession: async (input: unknown) => {
    assert.deepEqual(input, { sessionId: 'parent', provider: 'codex', executionAccountRef: 'a', projectPath: target.projectPath });
    return { status: 'adopted' as const, session };
  } };
  const url = new URL(await resolveBranchParentHref('parent', target, api), 'http://localhost');
  assert.equal(url.searchParams.get('sessionId'), 'native-parent');
  assert.equal(url.searchParams.get('projectPath'), target.projectPath);
  await assert.rejects(resolveBranchParentHref('parent', target, {
    resolveSession: async () => ({ status: 'adopted', session: { ...session, executionAccountRef: 'b' } }),
  }), /身份/);
});

test('Chat parent navigation retains canonical identity without a project or native lookup', async () => {
  const url = await resolveBranchParentHref('parent', { provider: 'kimi', executionAccountRef: 'a', projectPath: '',
    policy: { approvalMode: 'confirm', workspaceMode: 'chat' } }, {
    resolveSession: async () => { throw new Error('must not resolve native history'); },
  });
  assert.equal(url, '/ui/chat?provider=kimi&sessionId=parent');
});
