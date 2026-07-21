import { createProjectionErrorItem } from './projection-error-item';
import {
  activeInteractions,
  activeQueue,
  projectInteractionEvent,
  projectQueueEvent,
} from './active-projection';
import type { ProjectionGap, SessionProjection, StreamFailure } from './projection-types';
import type {
  ActiveTurn,
  CapabilitySnapshot,
  ChatRuntimeEvent,
  PendingInteraction,
  RuntimeBinding,
  SessionQueueEntry,
  SessionSnapshot,
  SessionState,
  TimelineItem,
} from './types';

export class ProjectionState {
  private state: SessionState = 'idle';
  private runtimeBinding?: RuntimeBinding;
  private capabilitySnapshot?: CapabilitySnapshot;
  private activeTurn?: ActiveTurn;
  private streamFailure?: StreamFailure;
  private policy: Readonly<Record<string, unknown>> = {};
  private queue: readonly SessionQueueEntry[] = [];
  private interactions: readonly PendingInteraction[] = [];
  private readonly items = new Map<string, TimelineItem>();
  private order: string[] = [];
  private readonly deltaChunks = new Map<string, string[]>();
  private timelineHasMore = false;
  private timelineNextBefore: string | null = null;

  hasItem(itemId: string): boolean {
    return this.items.has(itemId);
  }

  reset(snapshot: SessionSnapshot): void {
    this.state = snapshot.state;
    this.runtimeBinding = snapshot.runtimeBinding;
    this.capabilitySnapshot = snapshot.capabilitySnapshot;
    this.activeTurn = snapshot.activeTurn;
    this.streamFailure = undefined;
    this.policy = snapshot.policy;
    this.queue = activeQueue(snapshot.queue);
    this.interactions = activeInteractions(snapshot.interactions);
    this.items.clear();
    this.order = [];
    this.deltaChunks.clear();
    snapshot.timeline.forEach((item) => this.upsertItem(item));
    this.timelineHasMore = snapshot.timelineHasMore;
    this.timelineNextBefore = snapshot.timelineNextBefore;
  }

  prependTimeline(
    items: readonly TimelineItem[],
    hasMore: boolean,
    nextBefore: string | null,
  ): void {
    const added: string[] = [];
    items.forEach((item) => {
      if (this.items.has(item.id)) return;
      this.items.set(item.id, item);
      added.push(item.id);
    });
    this.order = [...added, ...this.order];
    this.timelineHasMore = hasMore;
    this.timelineNextBefore = nextBefore;
  }

  apply(event: ChatRuntimeEvent): void {
    if (event.type !== 'stream.error') this.streamFailure = undefined;
    if (this.applySessionEvent(event)) return;
    if (this.applyTurnOrRunEvent(event)) return;
    if (this.applyQueueEvent(event)) return;
    if (this.applyTimelineEvent(event)) return;
    if (this.applyInteractionEvent(event)) return;
    this.applyRuntimeEvent(event);
  }

  flushDeltas(): void {
    [...this.deltaChunks.keys()].forEach((itemId) => this.flushItemDelta(itemId));
  }

  toProjection(
    sessionId: string,
    throughSeq: number,
    gap?: ProjectionGap,
  ): Omit<SessionProjection, 'connectionState'> {
    return {
      sessionId,
      state: this.state,
      throughSeq,
      gap,
      streamFailure: this.streamFailure,
      runtimeBinding: this.runtimeBinding,
      capabilitySnapshot: this.capabilitySnapshot,
      activeTurn: this.activeTurn,
      policy: this.policy,
      queue: this.queue,
      interactions: this.interactions,
      items: this.order.flatMap((id) => this.items.get(id) ?? []),
      timelineHasMore: this.timelineHasMore,
      timelineNextBefore: this.timelineNextBefore,
    };
  }

  private applySessionEvent(event: ChatRuntimeEvent): boolean {
    if (event.type === 'session.created') this.state = event.payload.state;
    else if (event.type === 'session.closed') {
      this.state = 'closed';
      this.activeTurn = undefined;
    } else if (event.type === 'session.runtime.bound' || event.type === 'session.runtime.rebound') {
      this.applyRuntimeProjection(event.payload);
    } else if (event.type === 'session.policy.changed') this.policy = event.payload.policy;
    else if (event.type !== 'session.snapshot.reset') return false;
    return true;
  }

  private applyTurnOrRunEvent(event: ChatRuntimeEvent): boolean {
    if (event.type.startsWith('turn.') || event.type === 'run.adopted') {
      const payload = event.payload as { state: SessionState; activeTurn?: ActiveTurn | null };
      this.state = payload.state;
      this.activeTurn = payload.activeTurn ?? undefined;
      return true;
    }
    if (event.type === 'run.detached') {
      this.state = 'recovering';
      this.activeTurn = recoveryActiveTurn(this.activeTurn, event, 'recovering');
      return true;
    }
    if (event.type === 'run.reattached') {
      this.state = event.payload.state;
      this.activeTurn = recoveryActiveTurn(this.activeTurn, event, event.payload.state);
      return true;
    }
    if (event.type === 'run.lost') {
      if (this.state !== 'closed') this.state = 'idle';
      this.activeTurn = undefined;
      return true;
    }
    return false;
  }

  private applyQueueEvent(event: ChatRuntimeEvent): boolean {
    const projected = projectQueueEvent(this.queue, event);
    if (!projected) return false;
    this.queue = projected;
    return true;
  }

  private applyTimelineEvent(event: ChatRuntimeEvent): boolean {
    if (event.type === 'timeline.item.delta') {
      this.appendDelta(event.payload.itemId, event.payload.chunk);
      return true;
    }
    if (event.type === 'timeline.item.started' || event.type === 'timeline.item.updated'
      || event.type === 'timeline.item.completed') {
      this.upsertItem(event.payload.item);
      return true;
    }
    return false;
  }

  private applyInteractionEvent(event: ChatRuntimeEvent): boolean {
    const projected = projectInteractionEvent(this.interactions, event);
    if (!projected) return false;
    this.interactions = projected;
    return true;
  }

  private applyRuntimeEvent(event: ChatRuntimeEvent): void {
    if (event.type === 'runtime.prewarm.started' || event.type === 'runtime.prewarm.ready') {
      this.applyRuntimeProjection(event.payload);
    } else if (event.type === 'runtime.prewarm.failed') {
      this.upsertItem(createProjectionErrorItem(event));
    } else if (event.type === 'stream.error') {
      const retryable = event.payload.retryable ?? true;
      this.streamFailure = {
        eventId: event.eventId,
        error: event.payload.error,
        message: event.payload.message,
        retryable,
      };
      if (!retryable) this.upsertItem(createProjectionErrorItem(event));
    }
  }

  private applyRuntimeProjection(payload: {
    runtimeBinding?: RuntimeBinding;
    capabilitySnapshot?: CapabilitySnapshot;
  }): void {
    if (payload.runtimeBinding) this.runtimeBinding = payload.runtimeBinding;
    if (payload.capabilitySnapshot) this.capabilitySnapshot = payload.capabilitySnapshot;
  }

  private upsertItem(item: TimelineItem): void {
    this.flushItemDelta(item.id);
    if (!this.items.has(item.id)) this.order.push(item.id);
    this.items.set(item.id, item);
  }

  private appendDelta(itemId: string, chunk: string): void {
    const chunks = this.deltaChunks.get(itemId) ?? [];
    chunks.push(chunk);
    this.deltaChunks.set(itemId, chunks);
  }

  private flushItemDelta(itemId: string): void {
    const chunks = this.deltaChunks.get(itemId);
    const item = this.items.get(itemId);
    if (!chunks || !item) return;
    this.items.set(itemId, { ...item, content: `${item.content ?? ''}${chunks.join('')}` });
    this.deltaChunks.delete(itemId);
  }
}

function recoveryActiveTurn(
  current: ActiveTurn | undefined,
  event: ChatRuntimeEvent,
  state: SessionState,
): ActiveTurn | undefined {
  const matching = matchesRunIdentity(current, event) ? current : undefined;
  const turnId = event.turnId || matching?.turnId;
  if (!turnId) return undefined;
  const runId = event.runId || matching?.runId;
  const nativeTurnId = event.type === 'run.reattached'
    ? event.payload.nativeTurnId || matching?.nativeTurnId
    : matching?.nativeTurnId;
  return {
    turnId,
    ...(runId ? { runId } : {}),
    ...(matching?.clientUserMessageId
      ? { clientUserMessageId: matching.clientUserMessageId }
      : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    state,
  };
}

function matchesRunIdentity(
  current: ActiveTurn | undefined,
  event: ChatRuntimeEvent,
): boolean {
  if (!current) return false;
  if (event.turnId && event.turnId !== current.turnId) return false;
  return !event.runId || !current.runId || event.runId === current.runId;
}
