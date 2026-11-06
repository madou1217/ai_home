import { parseChatRuntimeEvent } from './event-parser';
import { SessionProjectionStore } from './session-projection-store';
import { loadEarlierTimeline } from './timeline-history-loader';
import type {
  ChatRuntimeApi,
  ChatRuntimeAttachment,
  ChatRuntimeAttachmentUpload,
  ChatRuntimeCommandResult,
  CommandCatalogEntry,
  ComposerCatalog,
  SessionCommandInput,
  SessionRuntimeControllerOptions,
  TimelinePage,
  TimelineQuery,
} from './api-types';
import type { ChatRuntimeCommand, ChatRuntimeCommandName } from './types';

const RECONNECT_DELAY_MS = 1000;

export class SessionRuntimeController {
  /** True when this browser surface attached only for read-only observation. */
  readOnly = false;
  readonly store: SessionProjectionStore;
  private readonly scheduleReconnect: (callback: () => void) => () => void;
  private eventStream?: ReturnType<ChatRuntimeApi['openEvents']>;
  private cancelReconnect?: () => void;
  private startTask?: Promise<void>;
  private resyncTask?: Promise<void>;
  private loadEarlierTask?: Promise<TimelinePage>;
  private throughSeq = 0;
  private disposed = false;
  private visible = true;
  private removeVisibilityListener?: () => void;

  constructor(
    readonly sessionId: string,
    private readonly api: ChatRuntimeApi,
    options: SessionRuntimeControllerOptions = {},
  ) {
    this.store = new SessionProjectionStore(sessionId, options.frameScheduler);
    this.scheduleReconnect = options.reconnectScheduler ?? browserReconnectScheduler;
    const visibility = options.visibilitySource;
    if (visibility) {
      this.visible = visibility.visibilityState !== 'hidden';
      const changed = () => this.setVisible(visibility.visibilityState !== 'hidden');
      visibility.addEventListener('visibilitychange', changed);
      // 网络恢复（online）与 bfcache 恢复（pageshow persisted）：legacy 会话页在这两处都会续接，
      // canonical 同样立即续接事件流（不等重连定时器），从游标补齐离线期间的进度。
      const win = typeof window === 'undefined' ? undefined : window;
      const resume = (): void => this.resumeEventStream();
      const pageShown = (event: Event): void => { if ((event as PageTransitionEvent).persisted) resume(); };
      win?.addEventListener('online', resume);
      win?.addEventListener('pageshow', pageShown);
      this.removeVisibilityListener = () => {
        visibility.removeEventListener('visibilitychange', changed);
        win?.removeEventListener('online', resume);
        win?.removeEventListener('pageshow', pageShown);
      };
    }
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('chat_runtime_controller_disposed'));
    if (!this.startTask) this.startTask = this.startFromSnapshot();
    return this.startTask;
  }

  async dispatch<N extends ChatRuntimeCommandName>(
    input: SessionCommandInput<N>,
  ): Promise<ChatRuntimeCommandResult> {
    // 首屏连接（快照 + 事件流）期间允许用户先发送：等 startTask 完成再下发，
    // 避免把「正在连接」变成输入禁用。重连/重同步仍等回到 connected，避免用旧状态写。
    await this.waitUntilDispatchReady();
    const command = { ...input, sessionId: this.sessionId } as ChatRuntimeCommand;
    return this.api.dispatchCommand(this.sessionId, command);
  }

  readTimeline(query: TimelineQuery = {}): Promise<TimelinePage> {
    return this.api.readTimeline(this.sessionId, query);
  }

  loadEarlier(limit = 20): Promise<TimelinePage> {
    if (this.disposed) return Promise.reject(new Error('chat_runtime_controller_disposed'));
    if (this.loadEarlierTask) return this.loadEarlierTask;
    const task = loadEarlierTimeline({
      sessionId: this.sessionId,
      api: this.api,
      store: this.store,
      limit,
      isDisposed: () => this.disposed,
    });
    this.loadEarlierTask = task;
    void task.then(
      () => this.clearLoadEarlierTask(task),
      () => this.clearLoadEarlierTask(task),
    );
    return task;
  }

  getCommandCatalog(): Promise<readonly CommandCatalogEntry[]> {
    return this.api.getCommandCatalog(this.sessionId);
  }

  getComposerCatalog(): Promise<ComposerCatalog> {
    return this.api.getComposerCatalog(this.sessionId);
  }

  uploadAttachments(
    attachments: readonly ChatRuntimeAttachmentUpload[],
  ): Promise<readonly ChatRuntimeAttachment[]> {
    return this.api.uploadAttachments(this.sessionId, attachments);
  }

  readArtifact(artifactId: string): Promise<Blob> {
    return this.api.readArtifact(artifactId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeVisibilityListener?.();
    this.removeVisibilityListener = undefined;
    this.cancelScheduledReconnect();
    this.closeEventStream();
    this.store.dispose();
  }

  private async startFromSnapshot(): Promise<void> {
    try {
      await this.replaceFromSnapshot();
      this.openEventStream();
    } catch (error) {
      this.startTask = undefined;
      throw error;
    }
  }

  private clearLoadEarlierTask(task: Promise<TimelinePage>): void {
    if (this.loadEarlierTask === task) this.loadEarlierTask = undefined;
  }

  private async replaceFromSnapshot(): Promise<void> {
    const snapshot = await this.api.getSnapshot(this.sessionId);
    if (this.disposed) return;
    this.store.reset(snapshot);
    this.throughSeq = snapshot.throughSeq;
  }

  private openEventStream(): void {
    if (this.disposed || !this.visible) return;
    this.cancelScheduledReconnect();
    this.closeEventStream();
    const stream = this.api.openEvents(this.sessionId, this.throughSeq);
    this.eventStream = stream;
    stream.onopen = () => this.handleStreamOpen(stream);
    stream.onmessage = (event) => this.receiveEvent(stream, event.data);
    stream.onerror = () => this.handleStreamError(stream);
  }

  private handleStreamOpen(stream: ReturnType<ChatRuntimeApi['openEvents']>): void {
    if (this.disposed || stream !== this.eventStream) return;
    this.store.setConnectionState('connected');
  }

  private receiveEvent(stream: ReturnType<ChatRuntimeApi['openEvents']>, data: string): void {
    if (this.disposed || stream !== this.eventStream) return;
    try {
      const result = this.store.apply(parseChatRuntimeEvent(data, this.sessionId));
      if (result.status === 'gap' || result.status === 'session_mismatch') {
        this.requestSnapshotResync();
        return;
      }
      this.throughSeq = Math.max(this.throughSeq, result.seq);
      this.store.setConnectionState('connected');
    } catch (_error) {
      this.requestSnapshotResync();
    }
  }

  private handleStreamError(stream: ReturnType<ChatRuntimeApi['openEvents']>): void {
    if (this.disposed || stream !== this.eventStream) return;
    this.closeEventStream();
    this.store.setConnectionState('reconnecting');
    this.queueReconnect(() => this.openEventStreamSafely());
  }

  private requestSnapshotResync(): void {
    if (this.disposed || !this.visible || this.resyncTask) return;
    this.store.setConnectionState('resyncing');
    this.closeEventStream();
    this.cancelScheduledReconnect();
    const task = this.resyncFromSnapshot();
    this.resyncTask = task;
    void task.finally(() => {
      if (this.resyncTask === task) this.resyncTask = undefined;
    });
  }

  private async resyncFromSnapshot(): Promise<void> {
    try {
      await this.replaceFromSnapshot();
      this.openEventStream();
    } catch (_error) {
      this.queueReconnect(() => this.requestSnapshotResync());
    }
  }

  private openEventStreamSafely(): void {
    try {
      this.openEventStream();
    } catch (_error) {
      this.queueReconnect(() => this.openEventStreamSafely());
    }
  }

  private queueReconnect(callback: () => void): void {
    if (this.disposed || !this.visible || this.cancelReconnect) return;
    this.cancelReconnect = this.scheduleReconnect(() => {
      this.cancelReconnect = undefined;
      callback();
    });
  }

  private cancelScheduledReconnect(): void {
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
  }

  private closeEventStream(): void {
    const stream = this.eventStream;
    this.eventStream = undefined;
    if (!stream) return;
    stream.onopen = null;
    stream.onmessage = null;
    stream.onerror = null;
    stream.close();
  }

  /**
   * 首屏 connecting 等 startTask（快照）完成即可下发；重连/重同步必须等 connected。
   * 超时只拒绝这一条命令，不改变连接状态，重连逻辑仍按自己的节奏继续。
   */
  private async waitUntilDispatchReady(): Promise<void> {
    const state = this.store.getConnectionState();
    if (state === 'connected') return;
    if (state === 'connecting') {
      if (!this.startTask) throw new Error('chat_runtime_connection_not_ready');
      await this.startTask;
      return;
    }
    if (state === 'resyncing') {
      // 重同步只补快照，不阻塞用户发送；等这一轮快照落地即可下发，避免 30s 等待。
      if (!this.resyncTask) throw new Error('chat_runtime_connection_not_ready');
      await this.resyncTask;
      return;
    }
    await this.waitForConnected();
  }

  private waitForConnected(timeoutMs = 30_000): Promise<void> {
    if (this.store.getConnectionState() === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = (): void => {};
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      unsubscribe = this.store.subscribe(() => {
        if (this.store.getConnectionState() === 'connected') finish();
      });
      timer = setTimeout(() => finish(new Error('chat_runtime_connection_not_ready')), timeoutMs);
      if (this.store.getConnectionState() === 'connected') finish();
    });
  }

  private resumeEventStream(): void {
    if (this.disposed || !this.visible || this.resyncTask) return;
    this.cancelScheduledReconnect();
    if (this.eventStream) this.closeEventStream();
    this.openEventStreamSafely();
  }

  private setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      // 回到前台只需从游标续接：服务端 SSE 会重放 throughSeq 之后的事件，游标超出保留窗口时
      // 自己下发 session.snapshot.reset。此前这里强制整份快照重同步，每次切回标签页都会
      // 闪「会话状态可能已过期」并暂停操作；真正的序列缺口仍由 receiveEvent 触发重同步。
      if (this.resyncTask || this.eventStream) return;
      this.openEventStreamSafely();
      return;
    }
    // 隐藏页只暂停事件观察，服务端继续生成；连接状态保持不变（页面不可见，没人看提示），
    // 返回时续接事件流补齐后台进度。
    this.cancelScheduledReconnect();
    this.closeEventStream();
  }
}

function browserReconnectScheduler(callback: () => void): () => void {
  const handle = globalThis.setTimeout(callback, RECONNECT_DELAY_MS);
  return () => globalThis.clearTimeout(handle);
}
