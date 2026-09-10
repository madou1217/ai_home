import type { SessionProjection, TimelineItem } from '@/chat-runtime';

type ReasoningItem = Extract<TimelineItem, { kind: 'reasoning' }>;

export function reasoningText(item: ReasoningItem): string {
  return item.content?.trim() ? item.content : item.detail.summary || '';
}

export function selectTimelinePresentation(projection: SessionProjection): {
  items: readonly TimelineItem[];
  runningReasoningId?: string;
  progressItemId?: string;
} {
  const latest = projection.items.at(-1);
  const runningReasoningId = projection.state === 'running'
    && projection.activeTurn
    && !projection.streamFailure
    && latest?.kind === 'reasoning'
    && (!latest.turnId || latest.turnId === projection.activeTurn.turnId)
    && (latest.status === 'pending' || latest.status === 'running')
    ? latest.id : undefined;

  // Keep the canonical events intact. Empty reasoning is activity, not history.
  const items = projection.items.filter((item) => {
      // The latest failure is rendered once, with its retry action below the response.
      if (projection.failedTurn && item.kind === 'error'
        && item.turnId === projection.failedTurn.turnId) return false;
      return item.kind !== 'reasoning'
        || reasoningText(item).trim()
        || item.id === runningReasoningId
        || item.status === 'failed'
        || item.status === 'cancelled';
    });
  return {
    runningReasoningId,
    progressItemId: projection.activeTurn && projection.state !== 'idle'
      ? items.findLast((item) => item.turnId === projection.activeTurn?.turnId
        && (item.kind === 'reasoning' || item.kind === 'message' && item.detail.role === 'assistant'))?.id
      : undefined,
    items,
  };
}
