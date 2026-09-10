import type { Session } from '@/types';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { createWebCommandId } from './command-id';

export function branchResultSession(response: unknown): Session {
  const value = response as { result?: { session?: { sessionId: string; provider: Session['provider'];
    executionAccountRef: string; policy: { title?: string }; updatedAt: number } } };
  const session = value?.result?.session;
  if (!session?.sessionId || !session.provider || !session.executionAccountRef) {
    throw new Error('分支会话返回无效，请重试');
  }
  return { id: session.sessionId, runtimeSessionId: session.sessionId, mode: 'chat', draft: false,
    provider: session.provider, accountRef: session.executionAccountRef,
    title: session.policy.title || '分支会话', updatedAt: session.updatedAt };
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
      // A definite HTTP rejection is safely retryable with a fresh command;
      // network failures retain identity because execution may have succeeded.
      if (error && typeof error === 'object' && 'statusCode' in error) this.clearPending(key);
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
