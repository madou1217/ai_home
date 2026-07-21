import type {
  ApprovalDecisionPayload,
  InteractionAnswerPayload,
  SessionQueueEntry,
  TurnSubmitPayload,
} from '@/chat-runtime';
import type { SessionCommandInput } from '@/chat-runtime';
import { createWebCommandId } from './command-id';
import {
  NOOP_RUNTIME_COMMAND_OBSERVER,
} from './runtime-command-observer';
import type {
  RuntimeCommandNotice,
  RuntimeCommandObserver,
} from './runtime-command-observer';

export interface RuntimeCommandDispatcher {
  dispatch(input: SessionCommandInput): Promise<unknown>;
}

export type ComposerDelivery =
  | 'turn'
  | 'steer_current'
  | 'after_tool_boundary'
  | 'after_turn';

export type TurnSubmission = TurnSubmitPayload;

export class SessionRuntimeActions {
  constructor(
    private readonly dispatcher: RuntimeCommandDispatcher,
    private readonly idFactory: () => string = createCommandId,
    private readonly observer: RuntimeCommandObserver = NOOP_RUNTIME_COMMAND_OBSERVER,
  ) {}

  submit(input: TurnSubmission): Promise<unknown> {
    const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
    return this.send('turn.submit', {
      content: requiredTurnContent(input.content, attachmentIds),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    });
  }

  deliver(content: string, delivery: ComposerDelivery): Promise<unknown> {
    if (delivery === 'turn') return this.submit({ content });
    if (delivery === 'steer_current') {
      return this.send('turn.intervene', {
        content: requiredContent(content), mode: 'steer_current',
      });
    }
    if (delivery === 'after_tool_boundary') {
      return this.send('queue.add', {
        content: requiredContent(content), policy: 'after_tool_boundary',
      });
    }
    return this.send('queue.add', {
      content: requiredContent(content), policy: 'after_turn',
    });
  }

  interrupt(): Promise<unknown> {
    return this.send('turn.interrupt', { reason: 'user_stop' });
  }

  answer(payload: InteractionAnswerPayload): Promise<unknown> {
    return this.send('interaction.answer', payload);
  }

  decide(payload: ApprovalDecisionPayload): Promise<unknown> {
    return this.send('approval.decide', payload);
  }

  editQueue(queueId: string, content: string): Promise<unknown> {
    return this.send('queue.edit', { queueId, content: requiredContent(content) });
  }

  removeQueue(queueId: string): Promise<unknown> {
    return this.send('queue.remove', { queueId });
  }

  moveQueue(entry: SessionQueueEntry, beforeQueueId?: string): Promise<unknown> {
    return this.send('queue.move', {
      queueId: entry.queueId, ...(beforeQueueId ? { beforeQueueId } : {}),
    });
  }

  dispatchQueue(queueId?: string): Promise<unknown> {
    return this.send('queue.dispatch', queueId ? { queueId } : {});
  }

  executeSlash(name: string, args?: string): Promise<unknown> {
    return this.send('slash.execute', {
      name: name.replace(/^\//, ''), ...(args ? { arguments: args } : {}),
    });
  }

  setPolicy(key: string, value: unknown): Promise<unknown> {
    return this.send('session.policy.set', { key, value });
  }

  private send<N extends SessionCommandInput['type']>(
    type: N,
    payload: Extract<SessionCommandInput, { type: N }>['payload'],
  ): Promise<unknown> {
    const input = { commandId: this.idFactory(), type, payload } as SessionCommandInput;
    const notice: RuntimeCommandNotice = { commandId: input.commandId, type: input.type };
    notifyObserver(() => this.observer.onCommandDispatch(notice));
    try {
      return this.dispatcher.dispatch(input).catch((error: unknown) => {
        notifyObserver(() => this.observer.onCommandDispatchFailed(notice));
        throw error;
      });
    } catch (error) {
      notifyObserver(() => this.observer.onCommandDispatchFailed(notice));
      return Promise.reject(error);
    }
  }
}

function requiredContent(value: string): string {
  const content = value.trim();
  if (!content) throw new Error('chat_turn_content_required');
  return content;
}

function requiredTurnContent(value: string, attachmentIds: readonly string[]): string {
  const content = value.trim();
  if (!content && attachmentIds.length === 0) throw new Error('chat_turn_content_required');
  return content;
}

function normalizeAttachmentIds(value: readonly string[] | undefined): readonly string[] {
  if (!value) return [];
  const ids = value.map((attachmentId) => attachmentId.trim()).filter(Boolean);
  if (ids.length !== value.length) throw new Error('chat_attachment_id_invalid');
  return ids;
}

function createCommandId(): string {
  return createWebCommandId();
}

function notifyObserver(notification: () => void): void {
  try { notification(); } catch (_error) {}
}
