import type { SessionQueueEntry, SessionState } from '@/chat-runtime';

export interface QueueMove {
  readonly beforeQueueId?: string;
}

export interface QueueRowPolicy {
  readonly mutable: boolean;
  readonly canDispatch: boolean;
  readonly moveUp?: QueueMove;
  readonly moveDown?: QueueMove;
}

export function queueRowPolicy(
  entries: readonly SessionQueueEntry[],
  index: number,
  sessionState: SessionState,
): QueueRowPolicy {
  const entry = entries[index];
  if (!entry || entry.status !== 'queued') return immutablePolicy;
  const previous = entries[index - 1];
  const next = entries[index + 1];
  const afterNext = entries[index + 2];
  return {
    mutable: true,
    canDispatch: sessionState === 'idle',
    ...(previous?.status === 'queued'
      ? { moveUp: { beforeQueueId: previous.queueId } }
      : {}),
    ...(next?.status === 'queued'
      ? { moveDown: { ...(afterNext ? { beforeQueueId: afterNext.queueId } : {}) } }
      : {}),
  };
}

const immutablePolicy: QueueRowPolicy = Object.freeze({
  mutable: false,
  canDispatch: false,
});
