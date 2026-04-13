import type { ChatMessage, Provider } from '@/types';

export declare function appendThinkingChunk(currentContent: string, thinkingChunk: string): string;

export declare function stripThinkingBlock(content: string): string;

export declare function decorateMessagesWithPendingState(input: {
  messages: ChatMessage[];
  loading?: boolean;
  externalPending?: boolean;
  loadingStatusText?: string;
  externalPendingStatusText?: string;
  activeProvider?: Provider | string;
  pendingTimestamp?: string | number;
}): {
  messages: ChatMessage[];
  usedSyntheticPending: boolean;
};
