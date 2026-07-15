import type { Provider } from '@/types';

export declare function appendQueuedMessage<T>(queueByKey: Record<string, T[]>, sessionKey: string, item: T): Record<string, T[]>;

export declare function prependQueuedMessage<T>(queueByKey: Record<string, T[]>, sessionKey: string, item: T): Record<string, T[]>;

export declare function removeQueuedMessage<T extends { id: string }>(
  queueByKey: Record<string, T[]>,
  sessionKey: string,
  messageId: string
): Record<string, T[]>;

export declare function shiftQueuedMessage<T>(
  queueByKey: Record<string, T[]>,
  sessionKey: string
): {
  nextState: Record<string, T[]>;
  shifted: T | null;
};

export declare function shiftQueuedMessageByMode<T extends { mode?: string }>(
  queueByKey: Record<string, T[]>,
  sessionKey: string,
  mode: string
): {
  nextState: Record<string, T[]>;
  shifted: T | null;
};

export declare function moveQueuedMessages<T>(
  queueByKey: Record<string, T[]>,
  fromKey: string,
  toKey: string
): Record<string, T[]>;

export declare function moveQueuedMessageToFront<T extends { id: string }>(
  queueByKey: Record<string, T[]>,
  sessionKey: string,
  messageId: string
): {
  nextState: Record<string, T[]>;
  moved: T | null;
};

export declare function resolveQueuedMode(provider: Provider | string, apiKeyMode?: boolean): 'after_turn' | 'after_tool_call';
