import type {
  ActiveTurn,
  CapabilitySnapshot,
  PendingInteraction,
  RuntimeBinding,
  SessionQueueEntry,
  SessionState,
  TimelineItem,
} from './types';

export interface ProjectionGap {
  readonly expectedSeq: number;
  readonly receivedSeq: number;
  readonly reason: 'sequence' | 'missing_item';
}

export interface StreamFailure {
  readonly eventId: string;
  readonly error: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SessionConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'resyncing';

export interface SessionProjection {
  readonly sessionId: string;
  readonly connectionState: SessionConnectionState;
  readonly state: SessionState;
  readonly throughSeq: number;
  readonly gap?: ProjectionGap;
  readonly streamFailure?: StreamFailure;
  readonly runtimeBinding?: RuntimeBinding;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly activeTurn?: ActiveTurn;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly queue: readonly SessionQueueEntry[];
  readonly interactions: readonly PendingInteraction[];
  readonly items: readonly TimelineItem[];
  readonly timelineHasMore: boolean;
  readonly timelineNextBefore: string | null;
}

export type ApplyEventResult =
  | { readonly status: 'applied'; readonly seq: number }
  | { readonly status: 'reset'; readonly seq: number }
  | { readonly status: 'duplicate'; readonly seq: number }
  | { readonly status: 'gap'; readonly gap: ProjectionGap }
  | { readonly status: 'session_mismatch'; readonly sessionId: string };
