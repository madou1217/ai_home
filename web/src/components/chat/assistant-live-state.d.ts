import type { ChatMessage } from '@/types';

export declare function appendAssistantText(
  messages: ChatMessage[],
  text: string,
  options?: {
    pending?: boolean;
    statusText?: string;
    timestamp?: string | number;
  }
): ChatMessage[];

export declare function appendAssistantThinking(
  messages: ChatMessage[],
  text: string,
  options?: {
    createIfMissing?: boolean;
    allowCompletedAssistant?: boolean;
    statusText?: string;
    timestamp?: string | number;
  }
): ChatMessage[];

export declare function appendAssistantToolContent(
  messages: ChatMessage[],
  text: string,
  options?: {
    pending?: boolean;
    statusText?: string;
    timestamp?: string | number;
  }
): ChatMessage[];

export declare function appendAssistantDelta(
  messages: ChatMessage[],
  delta: string,
  options?: {
    statusText?: string;
    timestamp?: string | number;
  }
): ChatMessage[];

export declare function finalizeAssistantMessage(
  messages: ChatMessage[],
  content?: string,
  options?: {
    timestamp?: string | number;
  }
): ChatMessage[];

export declare function clearPendingAssistant(
  messages: ChatMessage[],
  options?: {
    timestamp?: string | number;
  }
): ChatMessage[];
