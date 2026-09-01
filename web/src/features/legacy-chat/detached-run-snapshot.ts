// api-proxy 纯聊天 run 的恢复快照：只有 mode === 'api-proxy' 的 run 才携带已累积内容
// （native run 由 CLI 会话库/watch 重放负责），避免误触发 native 专属交互卡逻辑。
export function resolveApiProxyRunSnapshot(
  run: { readonly mode?: string; readonly contentSnapshot?: string } | null | undefined,
): string {
  if (!run || String(run.mode || '') !== 'api-proxy') return '';
  return String(run.contentSnapshot || '');
}
