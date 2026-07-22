import type { ChatAccount, Session } from '@/types';
import { usesCanonicalSessionRuntime } from './session-surface-policy';

export type ChatRuntimeBranch = 'empty' | 'canonical' | 'legacy';

export interface ChatRuntimeRenderers<T> {
  readonly empty: () => T;
  readonly canonical: (session: Session) => T;
  readonly legacy: (session: Session) => T;
}

export function resolveChatRuntimeBranch(
  session: Session | null,
  account?: ChatAccount | null,
): ChatRuntimeBranch {
  if (!session) return 'empty';
  return usesCanonicalSessionRuntime(session, account) ? 'canonical' : 'legacy';
}

export function renderChatRuntimeBranch<T>(
  session: Session | null,
  renderers: ChatRuntimeRenderers<T>,
  account?: ChatAccount | null,
): T {
  if (!session) return renderers.empty();
  return usesCanonicalSessionRuntime(session, account)
    ? renderers.canonical(session)
    : renderers.legacy(session);
}
