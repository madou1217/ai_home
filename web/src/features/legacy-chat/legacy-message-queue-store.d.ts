import type { QueuedSessionMessage } from './runtime-types';

type QueueState = Record<string, QueuedSessionMessage[]>;

export const legacyMessageQueueStore: {
  readonly getSnapshot: () => QueueState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ensureHydrated: (sessionKey: string) => void;
  readonly enqueue: (sessionKey: string, item: QueuedSessionMessage) => void;
  readonly prepend: (sessionKey: string, item: QueuedSessionMessage) => void;
  readonly remove: (sessionKey: string, messageId: string) => void;
  readonly shift: (sessionKey: string) => QueuedSessionMessage | null;
  readonly shiftByMode: (sessionKey: string, mode: QueuedSessionMessage['mode']) => QueuedSessionMessage | null;
  readonly move: (fromKey: string, toKey: string) => void;
  readonly prioritize: (sessionKey: string, messageId: string) => QueuedSessionMessage | null;
};
