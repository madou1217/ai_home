import type { Session } from '@/types';
import { usesCanonicalSessionRuntime } from './session-surface-policy';

export type ChatRuntimeBranch = 'empty' | 'canonical' | 'legacy';

export interface ChatRuntimeRenderers<T> {
  readonly empty: () => T;
  readonly canonical: (session: Session) => T;
  readonly legacy: (session: Session) => T;
}

export function resolveChatRuntimeBranch(session: Session | null): ChatRuntimeBranch {
  if (!session) return 'empty';
  return usesCanonicalSessionRuntime(session) ? 'canonical' : 'legacy';
}

export function renderChatRuntimeBranch<T>(
  session: Session | null,
  renderers: ChatRuntimeRenderers<T>,
): T {
  if (!session) return renderers.empty();
  return usesCanonicalSessionRuntime(session)
    ? renderers.canonical(session)
    : renderers.legacy(session);
}
