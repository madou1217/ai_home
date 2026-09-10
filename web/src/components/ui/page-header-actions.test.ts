import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVisibleActions, type PageHeaderAction } from './PageHeaderActions';

const actions: PageHeaderAction[] = [
  { key: 'discover', label: '发现局域网 Server', icon: null, hideOnMobile: true },
  { key: 'refresh', label: '同步全部', icon: null },
  { key: 'add', label: '添加 Server', icon: null, primary: true },
];

test('桌面端展示全部动作，包括标记为手机端隐藏的次要动作', () => {
  assert.deepEqual(selectVisibleActions(actions, false).map((a) => a.key),
    ['discover', 'refresh', 'add']);
});

test('手机端隐去 hideOnMobile 动作，给标题让出横向空间', () => {
  assert.deepEqual(selectVisibleActions(actions, true).map((a) => a.key),
    ['refresh', 'add']);
});

test('未标记 hideOnMobile 时两端动作集一致', () => {
  const plain = actions.filter((a) => !a.hideOnMobile);
  assert.deepEqual(selectVisibleActions(plain, true), selectVisibleActions(plain, false));
});
