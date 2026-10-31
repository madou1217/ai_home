import type { ChatRuntimeApi } from '@/chat-runtime';
import type { SessionRuntimeTarget } from './session-surface-policy';

export async function resolveBranchParentHref(
  parentSessionId: string, target: SessionRuntimeTarget, api: Pick<ChatRuntimeApi, 'resolveSession'>,
): Promise<string> {
  const query = new URLSearchParams({ provider: target.provider });
  if (target.policy.workspaceMode === 'chat') query.set('sessionId', parentSessionId);
  else {
    const { session } = await api.resolveSession({
      sessionId: parentSessionId, provider: target.provider,
      executionAccountRef: target.executionAccountRef, projectPath: target.projectPath,
    });
    const nativeId = session.runtimeBinding.nativeSessionId;
    if (session.sessionId !== parentSessionId || session.provider !== target.provider
      || session.executionAccountRef !== target.executionAccountRef || session.projectPath !== target.projectPath
      || typeof nativeId !== 'string' || !nativeId) throw new Error('原会话身份无法确认');
    query.set('sessionId', nativeId);
    query.set('projectPath', session.projectPath);
  }
  // 快捷窗口里跳转到原会话时留在 /chat/quick（带上原有的 embed/theme/mode），不把小窗带回主站。
  if (typeof window !== 'undefined' && /\/chat\/quick\/?$/.test(window.location.pathname)) {
    const current = new URLSearchParams(window.location.search);
    ['embed', 'theme', 'mode'].forEach((key) => { const value = current.get(key); if (value) query.set(key, value); });
    return `${window.location.pathname}?${query}`;
  }
  return `/ui/chat?${query}`;
}
