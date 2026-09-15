import type { Session } from '@/types';
import type { ChatRuntimeSession, TimelineItem, CommandCatalogEntry } from '@/chat-runtime';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { createWebCommandId } from './command-id';

export function branchResultSession(response: unknown): Session {
  const value = response as { result?: { session?: ChatRuntimeSession } };
  const session = value?.result?.session;
  if (!session?.sessionId || !session.provider || !session.executionAccountRef) {
    throw new Error('分支会话返回无效，请重试');
  }
  const chat = session.policy.workspaceMode === 'chat';
  const nativeId = session.runtimeBinding?.nativeSessionId;
  if (!chat && (typeof nativeId !== 'string' || !nativeId.trim() || !session.projectPath)) {
    throw new Error('分支会话缺少原生身份或项目路径');
  }
  return { id: chat ? session.sessionId : nativeId as string,
    runtimeSessionId: session.sessionId, mode: chat ? 'chat' : 'work', draft: false,
    provider: session.provider as Session['provider'], accountRef: session.executionAccountRef,
    ...(!chat ? { projectPath: session.projectPath } : {}),
    title: typeof session.policy.title === 'string' ? session.policy.title : '分支会话', updatedAt: session.updatedAt };
}

export function messageOperationAvailable(
  commands: readonly CommandCatalogEntry[], item: TimelineItem, kind: 'fork' | 'regenerate',
): boolean {
  return item.kind === 'message' && item.status === 'completed'
    && item.detail.phase !== 'interaction_answer'
    && (kind === 'regenerate' ? item.detail.role === 'assistant' : ['user', 'assistant'].includes(item.detail.role))
    && commands.some((command) => command.type === (kind === 'fork' ? 'session.fork' : 'turn.regenerate'));
}

export function messageOperationFailure(error: unknown): string {
  const failure = error as { code?: string; details?: { commandRecovery?: { disposition?: string } } };
  if (failure?.details?.commandRecovery?.disposition === 'resume') {
    return '分支结果尚待确认，请重试以恢复同一操作。';
  }
  if (failure?.code === 'chat_branch_source_busy') return '请等待当前回合结束后再操作。';
  if (failure?.code && /(?:history|evidence|identity|message).*unavailable|history_unsupported/.test(failure.code)) {
    return '这段历史缺少完整的原生记录，暂时无法从此处分支。';
  }
  return '消息操作未完成，请重试。';
}

// Keep a failed request's command ID until acknowledged; a lost HTTP response
// must not create another branch. The server owns all source content/identity.
export class MessageOperation {
  private pending = new Map<string, string>();
  constructor(private readonly actions: SessionRuntimeActions, private readonly sessionId = '') {}

  async execute(kind: 'fork' | 'regenerate', itemId: string): Promise<Session> {
    const key = `aih:message-operation:${this.sessionId}:${kind}:${itemId}`;
    const commandId = this.pending.get(key) || this.readPending(key) || createWebCommandId();
    this.pending.set(key, commandId);
    try { if (this.sessionId) window.sessionStorage.setItem(key, commandId); } catch { /* storage is optional */ }
    try {
      const session = branchResultSession(await this.actions[kind](itemId, commandId));
      this.clearPending(key);
      return session;
    } catch (error) {
      // Only durable command state proves a new command is safe. HTTP errors
      // can follow a successful native fork whose receipt was lost.
      const recovery = (error as { details?: { commandRecovery?: { commandId?: string; disposition?: string } } })
        ?.details?.commandRecovery;
      if (recovery?.commandId === commandId && recovery.disposition === 'new_command') this.clearPending(key);
      throw error;
    }
  }

  private readPending(key: string): string | null {
    try { return this.sessionId ? window.sessionStorage.getItem(key) : null; } catch { return null; }
  }

  private clearPending(key: string): void {
    this.pending.delete(key);
    try { if (this.sessionId) window.sessionStorage.removeItem(key); } catch { /* storage is optional */ }
  }
}
