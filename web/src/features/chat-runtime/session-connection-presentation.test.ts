import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runtimeFailurePresentation,
  sessionConnectionPresentation,
} from './session-connection-presentation';

test('connected projection is the only interactive connection state', () => {
  assert.deepEqual(sessionConnectionPresentation('connected'), {
    interactive: true,
    label: '实时已连接',
  });

  for (const state of ['connecting', 'reconnecting', 'resyncing'] as const) {
    const presentation = sessionConnectionPresentation(state);
    assert.equal(presentation.interactive, false);
    assert.ok(presentation.notice);
  }
});

test('recovery connection states explain why stale controls are paused', () => {
  assert.deepEqual(sessionConnectionPresentation('reconnecting'), {
    interactive: false,
    label: '正在重连',
    notice: '实时连接已中断，恢复前会话操作已暂停。',
  });
  assert.deepEqual(sessionConnectionPresentation('resyncing'), {
    interactive: false,
    label: '正在同步',
    notice: '会话状态可能已过期，重新同步完成前操作已暂停。',
  });
});

test('runtime failures never expose internal diagnostics in the chat surface', () => {
  assert.deepEqual(runtimeFailurePresentation({
    code: 'chat_session_account_required',
    message: 'chat_session_account_required',
  }), {
    title: 'AIH Server 需要刷新',
    description: '服务端仍在使用旧版会话协议，请重启 AIH Server 后重试。',
  });
  assert.deepEqual(runtimeFailurePresentation({
    code: 'chat_session_execution_account_required',
    message: 'chat_session_execution_account_required',
  }), {
    title: '请选择运行凭据',
    description: '请选择当前 provider 可用的 OAuth 或 API Key 凭据。',
  });
  assert.deepEqual(runtimeFailurePresentation({
    code: 'codex_app_server_process_exited',
    message: 'codex app-server process exited; log=/private/runtime.log',
  }), {
    title: 'Codex CLI 无法启动',
    description: 'PATH 默认的 Codex CLI 启动后立即退出，请修复默认安装后重试。',
  });

  const fallback = runtimeFailurePresentation({
    code: 'internal_private_failure',
    message: 'sensitive upstream detail',
  });
  assert.deepEqual(fallback, {
    title: 'AIH Chat Runtime 暂时不可用',
    description: '连接运行时失败，请稍后重试。',
  });
  assert.equal(JSON.stringify(fallback).includes('internal_private_failure'), false);
  assert.equal(JSON.stringify(fallback).includes('sensitive upstream detail'), false);
});
