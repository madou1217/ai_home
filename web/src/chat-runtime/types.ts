import type { TimelineDetailByKind } from './timeline-details';
import type { CapabilitySnapshot } from './capability-types';
import type { ApprovalDecisionPayload, InteractionAnswerPayload, TurnSubmitPayload } from './command-payload-types';
export type {
  ApprovalDecisionPayload,
  InteractionAnswer,
  InteractionAnswerValue,
  InteractionAnswerPayload,
  TurnSubmitPayload,
} from './command-payload-types';

import type {
  ApprovalInteractionPayload,
  QuestionInteractionPayload,
} from './interaction-types';
export { QUESTION_ACTIONS } from './interaction-types';
export type {
  ApprovalChoice,
  ApprovalChoiceIntent,
  ApprovalInteractionPayload,
  ApprovalInteractionPresentation,
  InteractionAnnotation,
  QuestionAction,
  QuestionAnswerShape,
  QuestionAutoResolution,
  QuestionAutoResolutionExpiration,
  QuestionAutoResolutionSnooze,
  QuestionField,
  QuestionFieldType,
  QuestionInteractionPayload,
  QuestionInteractionPresentation,
  QuestionOption,
  QuestionPresentationLink,
} from './interaction-types';

export type {
  CapabilityDescriptor,
  CapabilitySnapshot,
  CapabilitySupport,
  ChatCapabilityName,
} from './capability-types';

export const CHAT_RUNTIME_EVENT_SCHEMA = 'aih.chat.event.v1' as const;

export type TimelineItemKind =
  | 'message' | 'reasoning' | 'plan' | 'tool'
  | 'shell' | 'diff' | 'file_change' | 'terminal'
  | 'question' | 'approval' | 'subagent' | 'command'
  | 'attachment' | 'artifact' | 'notice' | 'error';

export type TimelineItemStatus = 'pending' | 'running' | 'waiting_input'
  | 'completed' | 'failed' | 'cancelled';

export type TimelineDeltaChannel =
  | 'summary' | 'content' | 'plan' | 'output' | 'diff' | 'progress';

export interface TimelineDeltaDetail {
  readonly channel: TimelineDeltaChannel;
  readonly index?: number;
}

interface TimelineItemBase {
  readonly id: string;
  readonly turnId?: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly status: TimelineItemStatus;
  readonly content?: string;
}

export type TimelineItem = {
  [K in TimelineItemKind]: TimelineItemBase & {
    readonly kind: K;
    readonly detail: Readonly<TimelineDetailByKind[K]>;
  };
}[TimelineItemKind];

export type SessionState = 'idle' | 'starting' | 'running' | 'waiting_input'
  | 'interrupting' | 'completing' | 'recovering' | 'closed';
export interface RuntimeBinding {
  readonly provider?: string;
  readonly runtimeId?: string;
  readonly nativeSessionId?: string;
  readonly fingerprint?: string;
  readonly version?: string;
  readonly runtimeGeneration?: number;
}

export interface ActiveTurn {
  readonly turnId: string;
  readonly runId?: string;
  readonly clientUserMessageId?: string;
  readonly nativeTurnId?: string;
  readonly state: SessionState;
}

export interface SessionQueueEntry {
  readonly queueId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly position: number;
  readonly policy: 'after_tool_boundary' | 'after_turn';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: 'queued' | 'leased' | 'running' | 'completed' | 'failed';
  readonly leaseId?: string;
  readonly boundaryItemId?: string;
  readonly result?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PendingInteractionFields {
  readonly interactionId: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly revision: number;
  readonly state: 'pending' | 'resolving' | 'answered' | 'expired';
  readonly resolution?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type PendingInteraction =
  | (PendingInteractionFields & {
    readonly kind: 'question' | 'plan_confirmation';
    readonly payload: QuestionInteractionPayload;
  })
  | (PendingInteractionFields & {
    readonly kind: 'approval';
    readonly payload: ApprovalInteractionPayload;
  });
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly throughSeq: number;
  readonly runtimeBinding?: RuntimeBinding;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly activeTurn?: ActiveTurn;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly queue: readonly SessionQueueEntry[];
  readonly interactions: readonly PendingInteraction[];
  readonly timeline: readonly TimelineItem[];
  readonly timelineHasMore: boolean;
  readonly timelineNextBefore: string | null;
}

export type ChatRuntimeCommandName =
  | 'runtime.prewarm' | 'turn.submit' | 'turn.intervene' | 'turn.interrupt'
  | 'queue.add' | 'queue.edit' | 'queue.remove' | 'queue.move' | 'queue.dispatch'
  | 'interaction.answer' | 'approval.decide' | 'slash.execute' | 'session.policy.set';

interface CommandPayloadByName {
  'runtime.prewarm': Record<string, never>;
  'turn.submit': TurnSubmitPayload;
  'turn.intervene': { content: string; mode: 'steer_current' | 'after_tool_boundary' | 'after_turn_same_run' | 'replace_current' };
  'turn.interrupt': { reason?: string };
  'queue.add': { content: string; policy: 'after_tool_boundary' | 'after_turn' };
  'queue.edit': { queueId: string; content: string };
  'queue.remove': { queueId: string };
  'queue.move': { queueId: string; beforeQueueId?: string };
  'queue.dispatch': { queueId?: string };
  'interaction.answer': InteractionAnswerPayload;
  'approval.decide': ApprovalDecisionPayload;
  'slash.execute': { name: string; arguments?: string };
  'session.policy.set': { key: string; value: unknown };
}

export type ChatRuntimeCommand<N extends ChatRuntimeCommandName = ChatRuntimeCommandName> = {
  [K in N]: {
    readonly commandId: string;
    readonly sessionId: string;
    readonly type: K;
    readonly payload: Readonly<CommandPayloadByName[K]>;
  };
}[N];

export interface ChatRuntimeEventSource {
  readonly provider: string;
  readonly runtimeId: string;
  readonly nativeEventId?: string;
}

interface StateProjectionPayload { state: SessionState; activeTurn?: ActiveTurn | null }
interface RuntimeProjectionPayload {
  runtimeBinding?: RuntimeBinding;
  capabilitySnapshot?: CapabilitySnapshot;
}
interface RunDetachedPayload { reason: string }
interface RunReattachedPayload { state: SessionState; nativeTurnId?: string }
interface RunLostPayload { error: Readonly<Record<string, unknown>> }

interface EventPayloadByType {
  'session.created': { state: SessionState };
  'session.runtime.bound': RuntimeProjectionPayload;
  'session.runtime.rebound': RuntimeProjectionPayload;
  'session.policy.changed': { policy: Readonly<Record<string, unknown>> };
  'session.closed': Record<string, never>;
  'session.snapshot.reset': SessionSnapshot;
  'turn.queued': StateProjectionPayload;
  'turn.started': StateProjectionPayload;
  'turn.phase.changed': StateProjectionPayload;
  'turn.interrupt.requested': StateProjectionPayload;
  'turn.interrupted': StateProjectionPayload;
  'turn.completed': StateProjectionPayload;
  'turn.failed': StateProjectionPayload;
  'queue.item.added': { entry: SessionQueueEntry };
  'queue.item.updated': { entry: SessionQueueEntry };
  'queue.item.moved': { queueId: string; beforeQueueId?: string };
  'queue.item.removed': { queueId: string };
  'queue.item.dispatched': { entry: SessionQueueEntry };
  'timeline.item.started': { item: TimelineItem };
  'timeline.item.delta': { itemId: string; chunk: string; detail?: TimelineDeltaDetail };
  'timeline.item.updated': { item: TimelineItem };
  'timeline.item.completed': { item: TimelineItem };
  'interaction.requested': { interaction: PendingInteraction };
  'interaction.updated': { interaction: PendingInteraction };
  'interaction.resolved': { interaction: PendingInteraction };
  'interaction.expired': { interaction: PendingInteraction };
  'run.detached': RunDetachedPayload;
  'run.reattached': RunReattachedPayload;
  'run.adopted': StateProjectionPayload;
  'run.lost': RunLostPayload;
  'runtime.prewarm.started': RuntimeProjectionPayload;
  'runtime.prewarm.ready': RuntimeProjectionPayload;
  'runtime.prewarm.failed': { error: string };
  'stream.error': { error: string; message: string; retryable?: boolean };
}

export type ChatRuntimeEventType = keyof EventPayloadByType;
export type ChatRuntimeEvent<T extends ChatRuntimeEventType = ChatRuntimeEventType> = {
  [K in T]: {
    readonly schema: typeof CHAT_RUNTIME_EVENT_SCHEMA;
    readonly eventId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly type: K;
    readonly at: number;
    readonly turnId?: string;
    readonly runId?: string;
    readonly itemId?: string;
    readonly source: ChatRuntimeEventSource;
    readonly payload: Readonly<EventPayloadByType[K]>;
  };
}[T];
