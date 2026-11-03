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
import type { ChatRuntimeEvent, SessionSnapshot, TimelineItem } from './types';

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
  // 本地回显：用户按下发送就先显示自己的消息，不必等服务端把 timeline 事件推回来
  // （实测 0.8s；codex 还要等原生侧回放 userMessage）。只存在于前端，服务端的同内容
  // 用户消息一到就替换掉；发送失败由调用方 discardLocalEcho 撤回。
  private localEchoes: TimelineItem[] = [];

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

  /** 立刻显示一条用户消息（本地回显），返回它的本地 id。 */
  echoUserMessage(content: string): string {
    const text = content.trim();
    const id = `local-echo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    if (!text) return id;
    this.localEchoes = [...this.localEchoes, {
      id,
      kind: 'message',
      detail: { role: 'user', phase: 'local_echo' },
      status: 'completed',
      content: text,
      createdAt: Date.now(),
    } as TimelineItem];
    this.schedulePublish();
    return id;
  }

  /** 发送失败：撤回本地回显。 */
  discardLocalEcho(id: string): void {
    const next = this.localEchoes.filter((item) => item.id !== id);
    if (next.length === this.localEchoes.length) return;
    this.localEchoes = next;
    this.schedulePublish();
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
    const projection = this.state.toProjection(this.sessionId, this.throughSeq, this.gap);
    return {
      ...projection,
      items: this.mergeLocalEchoes(projection.items),
      connectionState: this.connectionState,
    };
  }

  // 服务端已经有同内容的用户消息（比回显更晚创建）时，该回显视为已确认、丢弃；
  // 其余回显追加在时间线末尾。按内容配对只用于「隐藏本地副本」，不参与任何持久化。
  private mergeLocalEchoes(items: readonly TimelineItem[]): readonly TimelineItem[] {
    if (this.localEchoes.length === 0) return items;
    const confirmed = new Set<string>();
    const serverUser = items.filter((item) => item.kind === 'message' && item.detail.role === 'user');
    const used = new Set<string>();
    for (const echo of this.localEchoes) {
      const match = serverUser.find((item) => !used.has(item.id)
        && (item.content || '').trim() === (echo.content || '').trim()
        && item.createdAt >= echo.createdAt - 2000);
      if (match) { used.add(match.id); confirmed.add(echo.id); }
    }
    if (confirmed.size) this.localEchoes = this.localEchoes.filter((echo) => !confirmed.has(echo.id));
    return this.localEchoes.length ? [...items, ...this.localEchoes] : items;
  }
}
