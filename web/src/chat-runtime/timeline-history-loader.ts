import type { ChatRuntimeApi, TimelinePage } from './api-types';
import type { SessionProjectionStore } from './session-projection-store';

interface LoadEarlierTimelineOptions {
  readonly sessionId: string;
  readonly api: ChatRuntimeApi;
  readonly store: SessionProjectionStore;
  readonly limit: number;
  readonly isDisposed: () => boolean;
}

export async function loadEarlierTimeline(
  options: LoadEarlierTimelineOptions,
): Promise<TimelinePage> {
  const projection = options.store.getSnapshot();
  if (!projection.timelineHasMore) return emptyPage(projection);
  const before = projection.items[0]?.id ?? projection.timelineNextBefore;
  if (!before) throw new Error('chat_runtime_timeline_cursor_missing');
  const page = await options.api.readTimeline(options.sessionId, {
    before,
    limit: boundedLimit(options.limit),
  });
  if (!options.isDisposed()) options.store.prependTimeline(page);
  return page;
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(200, value)) : 20;
}

function emptyPage(
  projection: ReturnType<SessionProjectionStore['getSnapshot']>,
): TimelinePage {
  return {
    sessionId: projection.sessionId,
    items: [],
    hasMore: false,
    nextBefore: projection.timelineNextBefore,
    throughSeq: projection.throughSeq,
  };
}
