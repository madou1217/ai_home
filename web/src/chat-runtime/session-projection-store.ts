import { browserFrameScheduler } from './frame-scheduler';
import { ProjectionState } from './projection-state';
import type { FrameHandle, FrameScheduler } from './frame-scheduler';
import type { TimelinePage } from './api-types';
import type {
  ApplyEventResult,
  ProjectionGap,
  SessionConnectionState,
  SessionProjection,
} from './projection-types';
import type { ChatRuntimeEvent, SessionSnapshot } from './types';

type Listener = () => void;

export class SessionProjectionStore {
  private readonly state = new ProjectionState();
  private readonly listeners = new Set<Listener>();
  private connectionState: SessionConnectionState = 'connecting';
  private throughSeq = 0;
  private gap?: ProjectionGap;
  private framePending = false;
  private frameHandle?: FrameHandle;
  private published: SessionProjection;

  constructor(
    readonly sessionId: string,
    private readonly scheduler: FrameScheduler = browserFrameScheduler,
  ) {
    this.published = this.createProjection();
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SessionProjection => this.published;

  getConnectionState(): SessionConnectionState {
    return this.connectionState;
  }

  setConnectionState(connectionState: SessionConnectionState): void {
    if (connectionState === this.connectionState) return;
    this.connectionState = connectionState;
    this.schedulePublish();
  }

  apply(event: ChatRuntimeEvent): ApplyEventResult {
    if (event.sessionId !== this.sessionId) {
      return { status: 'session_mismatch', sessionId: event.sessionId };
    }
    if (event.type === 'session.snapshot.reset') {
      const throughSeq = Math.max(event.seq, event.payload.throughSeq);
      this.replaceSnapshot({ ...event.payload, throughSeq });
      return { status: 'reset', seq: throughSeq };
    }
    if (event.type === 'stream.error') {
      this.state.apply(event);
      this.schedulePublish();
      return { status: 'applied', seq: this.throughSeq };
    }
    if (event.seq <= this.throughSeq) {
      return { status: 'duplicate', seq: event.seq };
    }
    if (this.gap) return { status: 'gap', gap: this.gap };

    const expectedSeq = this.throughSeq + 1;
    if (event.seq !== expectedSeq) return this.rejectGap(expectedSeq, event.seq, 'sequence');
    if (event.type === 'timeline.item.delta' && !this.state.hasItem(event.payload.itemId)) {
      return this.rejectGap(expectedSeq, event.seq, 'missing_item');
    }

    this.throughSeq = event.seq;
    this.state.apply(event);
    this.schedulePublish();
    return { status: 'applied', seq: event.seq };
  }

  reset(snapshot: SessionSnapshot): void {
    if (snapshot.sessionId !== this.sessionId) {
      throw new Error(`Snapshot belongs to session ${snapshot.sessionId}`);
    }
    this.replaceSnapshot(snapshot);
  }

  prependTimeline(page: TimelinePage): void {
    if (page.sessionId !== this.sessionId) {
      throw new Error(`Timeline belongs to session ${page.sessionId}`);
    }
    this.state.prependTimeline(page.items, page.hasMore, page.nextBefore);
    this.schedulePublish();
  }

  dispose(): void {
    if (this.framePending && this.frameHandle) this.scheduler.cancel(this.frameHandle);
    this.framePending = false;
    this.listeners.clear();
  }

  private replaceSnapshot(snapshot: SessionSnapshot): void {
    this.state.reset(snapshot);
    this.throughSeq = snapshot.throughSeq;
    this.gap = undefined;
    this.schedulePublish();
  }

  private rejectGap(
    expectedSeq: number,
    receivedSeq: number,
    reason: ProjectionGap['reason'],
  ): ApplyEventResult {
    this.gap = { expectedSeq, receivedSeq, reason };
    this.schedulePublish();
    return { status: 'gap', gap: this.gap };
  }

  private schedulePublish(): void {
    if (this.framePending) return;
    this.framePending = true;
    this.frameHandle = this.scheduler.request(() => this.publish());
  }

  private publish(): void {
    this.framePending = false;
    this.state.flushDeltas();
    this.published = this.createProjection();
    this.listeners.forEach((listener) => listener());
  }

  private createProjection(): SessionProjection {
    return {
      ...this.state.toProjection(this.sessionId, this.throughSeq, this.gap),
      connectionState: this.connectionState,
    };
  }
}
