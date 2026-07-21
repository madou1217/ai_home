import type { FrameScheduler } from './frame-scheduler';
import type {
  CapabilitySnapshot,
  ChatRuntimeCommand,
  ChatRuntimeCommandName,
  SessionSnapshot,
  SessionState,
  TimelineItem,
} from './types';

export interface ChatRuntimeSession {
  readonly sessionId: string;
  readonly provider: string;
  readonly executionAccountRef: string;
  readonly projectPath: string;
  readonly state: SessionState;
  readonly lastEventSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly runtimeBinding: Readonly<Record<string, unknown>>;
  readonly capabilitySnapshot: CapabilitySnapshot;
  readonly activeTurn?: Readonly<Record<string, unknown>>;
}

export interface CreateSessionInput {
  readonly provider: string;
  readonly executionAccountRef: string;
  readonly projectPath?: string;
  readonly policy?: Readonly<Record<string, unknown>>;
}

export interface ResolveSessionInput extends CreateSessionInput {
  readonly nativeSessionId: string;
}

export type SessionResolutionStatus = 'created' | 'adopted';

export interface SessionResolution {
  readonly status: SessionResolutionStatus;
  readonly session: ChatRuntimeSession;
}

export interface SessionListQuery {
  readonly provider?: string;
  readonly projectPath?: string;
  readonly nativeSessionId?: string;
}

export interface TimelineQuery {
  readonly before?: string;
  readonly limit?: number;
}

export interface TimelinePage {
  readonly sessionId: string;
  readonly items: readonly TimelineItem[];
  readonly hasMore: boolean;
  readonly nextBefore: string | null;
  readonly throughSeq: number;
}

export interface ChatRuntimeCommandResult {
  readonly sessionId: string;
  readonly commandId: string;
  readonly acceptedSeq: number;
  readonly duplicate: boolean;
  readonly result?: unknown;
}

export interface CommandCatalogEntry extends Readonly<Record<string, unknown>> {
  readonly type?: string;
  readonly id?: string;
}

export interface ComposerModelOption {
  readonly id: string;
  readonly label: string;
  readonly supportedEfforts: readonly string[];
  readonly defaultEffort: string;
}

export interface ComposerCatalog {
  readonly models: readonly ComposerModelOption[];
  readonly defaultModel: string;
}

export interface ChatRuntimeAttachmentUpload {
  readonly name: string;
  readonly mimeType: string;
  readonly dataUrl: string;
}

export interface ChatRuntimeAttachment {
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly createdAt: number;
}

type WithoutSessionId<Command> = Command extends unknown ? Omit<Command, 'sessionId'> : never;

export type SessionCommandInput<N extends ChatRuntimeCommandName = ChatRuntimeCommandName> =
  WithoutSessionId<Extract<ChatRuntimeCommand, { type: N }>>;

export interface ChatRuntimeEventStream {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface ChatRuntimeTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  fetchBlob(input: RequestInfo | URL, init?: RequestInit): Promise<Blob>;
  openEvents(path: string): ChatRuntimeEventStream;
}

export interface ChatRuntimeApi {
  createSession(input: CreateSessionInput): Promise<ChatRuntimeSession>;
  resolveSession(input: ResolveSessionInput): Promise<SessionResolution>;
  listSessions(query?: SessionListQuery): Promise<readonly ChatRuntimeSession[]>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  readTimeline(sessionId: string, query?: TimelineQuery): Promise<TimelinePage>;
  dispatchCommand(sessionId: string, command: ChatRuntimeCommand): Promise<ChatRuntimeCommandResult>;
  getCommandCatalog(sessionId: string): Promise<readonly CommandCatalogEntry[]>;
  getComposerCatalog(sessionId: string): Promise<ComposerCatalog>;
  uploadAttachments(
    sessionId: string,
    attachments: readonly ChatRuntimeAttachmentUpload[],
  ): Promise<readonly ChatRuntimeAttachment[]>;
  readArtifact(artifactId: string): Promise<Blob>;
  openEvents(sessionId: string, after: number): ChatRuntimeEventStream;
}

export type ReconnectScheduler = (callback: () => void) => () => void;

export interface SessionRuntimeControllerOptions {
  readonly frameScheduler?: FrameScheduler;
  readonly reconnectScheduler?: ReconnectScheduler;
}
