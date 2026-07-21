import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingInteraction } from '@/chat-runtime';
import { approvalInteractionViewModel } from './approval-interaction-policy';

test('approval view model preserves adapter choice order and ids without native interpretation', () => {
  const view = approvalInteractionViewModel(interaction({
    presentation: {
      title: '文件更改审批',
      description: '修改文件',
      detail: 'src/App.tsx',
      annotations: [{ label: '范围', value: '/repo' }],
    },
    choices: [
      { id: 'file.once', label: '允许一次', intent: 'accept' },
      { id: 'file.cancel', label: '取消', description: '采用其他方式', intent: 'cancel' },
    ],
  }));

  assert.equal(view.title, '文件更改审批');
  assert.equal(view.detail, 'src/App.tsx');
  assert.deepEqual(view.annotations, [{ label: '范围', value: '/repo' }]);
  assert.deepEqual(view.options, [
    { id: 'file.once', label: '允许一次', intent: 'accept', tone: 'primary' },
    {
      id: 'file.cancel', label: '取消', description: '采用其他方式',
      intent: 'cancel', tone: 'danger',
    },
  ]);
});

test('approval view model never manufactures file or permission decisions', () => {
  const file = approvalInteractionViewModel(interaction({
    presentation: { title: '文件审批' },
    choices: [{ id: 'file.cancel', label: '取消', intent: 'cancel' }],
  }));
  const permissions = approvalInteractionViewModel(interaction({
    presentation: { title: '权限请求' },
    choices: [{ id: 'permission.turn', label: '仅本轮授予', intent: 'accept' }],
  }));

  assert.deepEqual(file.options.map(({ id }) => id), ['file.cancel']);
  assert.deepEqual(permissions.options.map(({ id }) => id), ['permission.turn']);
});

function interaction(
  payload: Extract<PendingInteraction, { kind: 'approval' }>['payload'],
): Extract<PendingInteraction, { kind: 'approval' }> {
  return {
    interactionId: 'approval-1', sessionId: 'session-1', itemId: 'item-1',
    revision: 1, state: 'pending', createdAt: 1, updatedAt: 1,
    kind: 'approval', payload,
  };
}
