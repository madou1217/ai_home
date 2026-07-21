import type { ChatRuntimeEvent, TimelineItem } from './types';

type ErrorEvent = Extract<ChatRuntimeEvent, {
  type: 'runtime.prewarm.failed' | 'stream.error';
}>;

export function createProjectionErrorItem(event: ErrorEvent): TimelineItem {
  const error = event.payload.error;
  const content = event.type === 'stream.error' ? event.payload.message : error;
  return {
    id: event.itemId ?? `runtime-error:${event.eventId}`,
    kind: 'error',
    createdAt: event.at,
    status: 'failed',
    content,
    detail: { code: error, retryable: event.type === 'stream.error' && event.payload.retryable },
  };
}
