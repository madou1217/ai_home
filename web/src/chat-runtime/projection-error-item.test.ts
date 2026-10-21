import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createProjectionErrorItem } from './projection-error-item';


// 2026-10-21 真机反馈：workbuddy 会话的「运行错误」显示成 codex_app_server_rpc_error。
// 服务端现在会带 message，但**修复前写入的历史事件** payload 里只有裸码 ——
// 老会话重开必须也能看到可读文案，否则用户仍然面对一个归属错乱、无法行动的错误。
test('历史 prewarm 失败事件（无 message）回退成可读文案并保留机器码', () => {
  const item = createProjectionErrorItem({
    type: 'runtime.prewarm.failed',
    eventId: 'event-legacy',
    at: 1,
    source: { provider: 'workbuddy', runtimeId: 'codex:chat-1' },
    payload: { error: 'codex_app_server_rpc_error' },
  } as never);

  assert.doesNotMatch(String(item.content), /^codex_app_server_rpc_error$/);
  assert.match(String(item.content), /会话运行时/);
  assert.match(String(item.content), /workbuddy/);
  // 机器码不能丢 —— 排障与重试判定都靠它。
  assert.equal((item.detail as { code?: string }).code, 'codex_app_server_rpc_error');
});

test('服务端给的 message 优先于前端兜底', () => {
  const item = createProjectionErrorItem({
    type: 'runtime.prewarm.failed',
    eventId: 'event-new',
    at: 1,
    source: { provider: 'workbuddy', runtimeId: 'codex:chat-1' },
    payload: { error: 'codex_app_server_rpc_error', message: '服务端文案' },
  } as never);
  assert.equal(item.content, '服务端文案');
});
