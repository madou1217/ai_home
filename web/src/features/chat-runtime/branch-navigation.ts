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
  return `/ui/chat?${query}`;
}
