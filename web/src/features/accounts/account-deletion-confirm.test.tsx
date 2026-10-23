import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  describeDeletionOccupant,
  isAccountOccupiedError
} from '@/features/accounts/account-deletion-confirm';

test('isAccountOccupiedError only matches the occupied payload', () => {
  assert.equal(isAccountOccupiedError({ error: 'account_runtime_active' }), true);
  assert.equal(isAccountOccupiedError({ error: 'delete_account_failed' }), false);
  assert.equal(isAccountOccupiedError(undefined), false);
  assert.equal(isAccountOccupiedError(null), false);
});

test('describeDeletionOccupant prefers the concrete session identifier', () => {
  assert.equal(
    describeDeletionOccupant({ kind: 'native_session', label: '运行中的会话', sessionId: 'abc' }),
    '运行中的会话：abc'
  );
  assert.equal(
    describeDeletionOccupant({ kind: 'persistent_session', label: '挂起的持久会话（tmux）', session: 'p-1' }),
    '挂起的持久会话（tmux）：p-1'
  );
  // 没有具体标识时只给标签，不拼出「：」这种空尾巴。
  assert.equal(describeDeletionOccupant({ label: '运行中的会话' }), '运行中的会话');
  assert.equal(describeDeletionOccupant({}), '占用进程');
});

test('occupied deletion confirm renders every occupant and the consequence', async () => {
  const { confirmOccupiedAccountDeletion } = await import('@/features/accounts/account-deletion-confirm');
  // Modal.confirm 在 SSR 下不渲染，直接取它的 content 元素做静态渲染断言。
  const calls: any[] = [];
  const originalConfirm = (await import('antd')).Modal.confirm;
  (await import('antd')).Modal.confirm = ((config: any) => {
    calls.push(config);
    return { destroy() {}, update() {} } as any;
  }) as any;
  try {
    confirmOccupiedAccountDeletion({
      data: {
        message: '该账号有运行中的会话正在占用（abc），删除会终止它们。',
        occupants: [
          { kind: 'native_session', label: '运行中的会话', sessionId: 'abc' },
          { kind: 'persistent_session', label: '挂起的持久会话（tmux）', session: 'p-1' }
        ]
      },
      onConfirm: () => {}
    });
  } finally {
    (await import('antd')).Modal.confirm = originalConfirm;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].okText, '终止并删除');
  assert.equal(calls[0].okButtonProps?.danger, true);
  const html = renderToStaticMarkup(calls[0].content);
  assert.match(html, /运行中的会话：abc/);
  assert.match(html, /挂起的持久会话（tmux）：p-1/);
  assert.match(html, /继续删除将终止以上会话/);
});
