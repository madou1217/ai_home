import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceStatusLabel } from './workspace-status-presentation';

test('workspace status keeps runtime state and elapsed time in one label', () => {
  assert.equal(workspaceStatusLabel('running', 'connected', 1_000, 13_400), '运行中 · 12秒');
  assert.equal(workspaceStatusLabel('idle', 'connected', undefined, 13_400), '就绪');
});

test('connection recovery takes precedence over a stale runtime state', () => {
  assert.equal(workspaceStatusLabel('running', 'reconnecting', 1_000, 13_400), '正在重连');
  assert.equal(workspaceStatusLabel('running', 'resyncing', 1_000, 13_400), '正在同步');
});
