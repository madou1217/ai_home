import type { ReactNode } from 'react';
import type { ChatAccount, Session } from '@/types';
import {
  renderChatRuntimeBranch,
  type ChatRuntimeRenderers,
} from './chat-runtime-branch';

interface ChatRuntimeBoundaryProps extends ChatRuntimeRenderers<ReactNode> {
  readonly session: Session | null;
  readonly account: ChatAccount | null;
}

export default function ChatRuntimeBoundary({
  session,
  account,
  empty,
  canonical,
  legacy,
}: ChatRuntimeBoundaryProps) {
  return renderChatRuntimeBranch(session, { empty, canonical, legacy }, account);
}
