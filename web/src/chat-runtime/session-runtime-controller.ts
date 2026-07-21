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
  readonly store: SessionProjectionStore;
  private readonly scheduleReconnect: (callback: () => void) => () => void;
  private eventStream?: ReturnType<ChatRuntimeApi['openEvents']>;
  private cancelReconnect?: () => void;
  private startTask?: Promise<void>;
  private resyncTask?: Promise<void>;
  private loadEarlierTask?: Promise<TimelinePage>;
  private throughSeq = 0;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly api: ChatRuntimeApi,
    options: SessionRuntimeControllerOptions = {},
  ) {
    this.store = new SessionProjectionStore(sessionId, options.frameScheduler);
    this.scheduleReconnect = options.reconnectScheduler ?? browserReconnectScheduler;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('chat_runtime_controller_disposed'));
    if (!this.startTask) this.startTask = this.startFromSnapshot();
    return this.startTask;
  }

  dispatch<N extends ChatRuntimeCommandName>(
    input: SessionCommandInput<N>,
  ): Promise<ChatRuntimeCommandResult> {
    if (this.store.getConnectionState() !== 'connected') {
      return Promise.reject(new Error('chat_runtime_connection_not_ready'));
    }
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
    if (this.disposed) return;
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
    if (this.disposed || this.resyncTask) return;
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
    if (this.disposed || this.cancelReconnect) return;
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
}

function browserReconnectScheduler(callback: () => void): () => void {
  const handle = globalThis.setTimeout(callback, RECONNECT_DELAY_MS);
  return () => globalThis.clearTimeout(handle);
}
