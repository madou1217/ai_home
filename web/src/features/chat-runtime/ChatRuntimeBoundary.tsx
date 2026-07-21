import type { ReactNode } from 'react';
import type { Session } from '@/types';
import {
  renderChatRuntimeBranch,
  type ChatRuntimeRenderers,
} from './chat-runtime-branch';

interface ChatRuntimeBoundaryProps extends ChatRuntimeRenderers<ReactNode> {
  readonly session: Session | null;
}

export default function ChatRuntimeBoundary({
  session,
  empty,
  canonical,
  legacy,
}: ChatRuntimeBoundaryProps) {
  return renderChatRuntimeBranch(session, { empty, canonical, legacy });
}
