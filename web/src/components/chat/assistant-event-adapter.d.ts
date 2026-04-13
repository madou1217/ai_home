import type { ChatMessage, ChatStreamEvent, SessionEventItem } from '@/types';

export declare function applySessionAssistantEvent(
  messages: ChatMessage[],
  event: SessionEventItem,
  options?: {
    pending?: boolean;
    provider?: string;
    thinkingStatusText?: string;
    processingStatusText?: string;
  }
): ChatMessage[];

export declare function applyStreamingAssistantEvent(
  messages: ChatMessage[],
  event: ChatStreamEvent,
  options?: {
    timestamp?: string | number;
    provider?: string;
    thinkingStatusText?: string;
    processingStatusText?: string;
    generatingStatusText?: string;
  }
): ChatMessage[];
