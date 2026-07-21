import { useEffect, useSyncExternalStore } from 'react';
import {
  getSessionRunKey,
  resolveSelectedSessionQueueKey,
} from '@/components/chat/active-run-state.js';
import type { Session } from '@/types';
import type { QueuedSessionMessage } from './runtime-types';
import { legacyMessageQueueStore } from './legacy-message-queue-store.js';

type QueueState = Record<string, QueuedSessionMessage[]>;

export interface LegacyMessageQueue {
  readonly state: QueueState;
  readonly selectedKey: string;
  readonly selectedMessages: QueuedSessionMessage[];
  readonly enqueue: (sessionKey: string, item: QueuedSessionMessage) => void;
  readonly prepend: (sessionKey: string, item: QueuedSessionMessage) => void;
  readonly remove: (sessionKey: string, messageId: string) => void;
  readonly shift: (sessionKey: string) => QueuedSessionMessage | null;
  readonly shiftByMode: (
    sessionKey: string,
    mode: QueuedSessionMessage['mode'],
  ) => QueuedSessionMessage | null;
  readonly move: (fromKey: string, toKey: string) => void;
  readonly prioritize: (sessionKey: string, messageId: string) => QueuedSessionMessage | null;
}

export function useLegacyMessageQueue(
  selectedSession: Session,
  selectedRunKey: string,
): LegacyMessageQueue {
  const state = useSyncExternalStore(
    legacyMessageQueueStore.subscribe,
    legacyMessageQueueStore.getSnapshot,
    legacyMessageQueueStore.getSnapshot,
  );
  const selectedKey = resolveSelectedSessionQueueKey(selectedSession, selectedRunKey);
  const selectedMessages = selectedKey ? state[selectedKey] || [] : [];

  useEffect(() => {
    if (selectedSession.draft) return;
    const key = getSessionRunKey(selectedSession);
    if (!key) return;
    legacyMessageQueueStore.ensureHydrated(key);
  }, [
    selectedSession.draft,
    selectedSession.id,
    selectedSession.projectDirName,
    selectedSession.provider,
  ]);

  return {
    state,
    selectedKey,
    selectedMessages,
    enqueue: legacyMessageQueueStore.enqueue,
    prepend: legacyMessageQueueStore.prepend,
    remove: legacyMessageQueueStore.remove,
    shift: legacyMessageQueueStore.shift,
    shiftByMode: legacyMessageQueueStore.shiftByMode,
    move: legacyMessageQueueStore.move,
    prioritize: legacyMessageQueueStore.prioritize,
  };
}
