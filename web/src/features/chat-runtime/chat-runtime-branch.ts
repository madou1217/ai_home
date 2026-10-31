import type { ChatAccount, Session } from '@/types';
import { usesCanonicalSessionRuntime } from './session-surface-policy';

// fallback：不能进 canonical 的会话（无原生运行时的 provider 的历史 / 账号形态跑不了原生 CLI 的草稿），
// 由 ChatRuntimeFallback 只读展示或给出原因 —— 不再有第二套聊天实现。
export type ChatRuntimeBranch = 'empty' | 'canonical' | 'fallback';

export interface ChatRuntimeRenderers<T> {
  readonly empty: () => T;
  readonly canonical: (session: Session) => T;
  readonly fallback: (session: Session) => T;
}

export function resolveChatRuntimeBranch(
  session: Session | null,
  account?: ChatAccount | null,
): ChatRuntimeBranch {
  if (!session) return 'empty';
  return usesCanonicalSessionRuntime(session, account) ? 'canonical' : 'fallback';
}

export function renderChatRuntimeBranch<T>(
  session: Session | null,
  renderers: ChatRuntimeRenderers<T>,
  account?: ChatAccount | null,
): T {
  if (!session) return renderers.empty();
  return usesCanonicalSessionRuntime(session, account)
    ? renderers.canonical(session)
    : renderers.fallback(session);
}
