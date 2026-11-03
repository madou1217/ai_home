import type { ChatRuntimeEvent, TimelineItem } from './types';

type ErrorEvent = Extract<ChatRuntimeEvent, {
  type: 'runtime.prewarm.failed' | 'stream.error';
}>;

/**
 * 内部 harness 错误码 → 用户文案的**前端兜底**。
 *
 * 服务端已经会带 `message`（见 lib/server/chat-runtime/runtime-failure-copy.js），
 * 但**修复前写入的历史事件** payload 里只有裸码。不兜底的话，老会话重新打开仍会显示
 * 「workbuddy 会话报 codex_app_server_rpc_error」这种归属错乱、无法行动的错误。
 *
 * 只登记能确认归属的码；未登记的码不猜，原样显示（服务端会把新事件的文案补上）。
 * 文案与服务端保持一致，避免同一故障两种说法。
 */
const HARNESS_FAILURE_FALLBACK: Readonly<Record<string, string>> = {
  codex_app_server_rpc_error: '会话运行时（Codex harness）通信失败，本轮未开始',
  codex_app_server_closed: '会话运行时（Codex harness）进程已退出，本轮未开始',
  codex_app_server_spawn_failed: '无法启动会话运行时（Codex harness）',
  codex_app_server_ready_timeout: '会话运行时（Codex harness）启动超时',
  runtime_prewarm_failed: '会话运行时启动失败，本轮未开始',
};

function describeRuntimeFailure(code: string, provider: string): string {
  const copy = HARNESS_FAILURE_FALLBACK[code];
  if (!copy) return code;
  return provider ? `${copy}（${provider} 会话，运行时与账号无关）` : copy;
}

export function createProjectionErrorItem(event: ErrorEvent): TimelineItem {
  const error = event.payload.error;
  // 正文优先用服务端给的**用户文案**：prewarm 失败时 error 是内部 harness 码
  // （chat 模式的 harness 是 Codex app-server，所以任何 provider 都会看到 codex_* 前缀），
  // 直接当正文会显示成「workbuddy 会话报 codex_app_server_rpc_error」这种归属错乱、
  // 无法行动的错误。历史事件没有 message，用本模块的兜底表补上。
  // 码仍留在 detail.code 里供排障。
  const content = event.type === 'stream.error'
    ? event.payload.message
    : (event.payload.message || describeRuntimeFailure(error, event.source?.provider || ''));
  return {
    id: event.itemId ?? `runtime-error:${event.eventId}`,
    kind: 'error',
    createdAt: event.at,
    status: 'failed',
    content,
    detail: { code: error, retryable: event.type === 'stream.error' && event.payload.retryable },
  };
}
