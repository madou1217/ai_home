import type { FailedTurn, SessionProjection } from '@/chat-runtime';

export function turnFailureMessage(failure: FailedTurn): string {
  const diagnostic = `${failure.error.code} ${failure.error.message || ''}`;
  if (/auth_invalid|invalid_grant|invalid_authentication|reauth_required/i.test(diagnostic)) {
    return '此账号的登录凭据已失效，请重新登录后重试。';
  }
  return '本轮执行失败。';
}

export function turnProgressText(projection: SessionProjection, now: number): string {
  if (!['starting', 'running', 'interrupting', 'completing', 'recovering'].includes(projection.state)) return '';
  const turn = projection.activeTurn;
  const hasOutput = projection.items.some((item) => item.turnId === turn?.turnId && (
    item.kind === 'message' ? item.detail.role === 'assistant' && Boolean(item.content?.trim())
      : ['reasoning', 'tool', 'shell', 'plan'].includes(item.kind)
  ));
  const label = projection.state === 'interrupting' ? '正在停止'
    : projection.state === 'recovering' ? '正在恢复连接'
      : projection.state === 'completing' ? '正在收尾'
        : hasOutput ? '正在处理' : '等待模型响应';
  const seconds = turn?.startedAt === undefined ? null : Math.max(0, Math.floor((now - turn.startedAt) / 1000));
  return seconds === null ? `${label}…` : `${label} · 已用时 ${seconds} 秒`;
}
