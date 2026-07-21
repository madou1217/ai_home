import { applySessionAssistantEvent } from '@/components/chat/assistant-event-adapter.js';
import {
  getProcessingStatusText,
  getThinkingStatusText,
} from '@/components/chat/provider-pending-policy.js';
import type { ChatMessage, Session, SessionEventItem } from '@/types';
import { dedupeChatMessages } from './message-history-policy';

export type LegacySessionEventEffect = 'clear_pending' | 'mark_thinking' | 'tool_boundary';

interface ProjectLegacySessionEventsInput {
  readonly messages: ChatMessage[];
  readonly events: SessionEventItem[];
  readonly session: Session;
  readonly current: boolean;
  readonly running: boolean;
}

export interface LegacySessionEventProjection {
  readonly messages: ChatMessage[];
  readonly effects: LegacySessionEventEffect[];
}

export function projectLegacySessionEvents({
  messages,
  events,
  session,
  current,
  running,
}: ProjectLegacySessionEventsInput): LegacySessionEventProjection {
  let projected = [...messages];
  const effects: LegacySessionEventEffect[] = [];
  events.forEach((event) => {
    if (event.type === 'user_message') {
      projected = appendUserMessage(projected, event);
      return;
    }
    if (event.type === 'assistant_text') {
      if (current) effects.push('clear_pending');
      projected = projectAssistantEvent(projected, event, session, false);
      return;
    }
    if (event.type === 'assistant_reasoning') {
      effects.push('mark_thinking');
      projected = projectAssistantEvent(projected, event, session, false);
      return;
    }
    if (event.type === 'assistant_tool_call' || event.type === 'assistant_tool_result') {
      if (event.type === 'assistant_tool_call') effects.push('tool_boundary');
      if (current) effects.push('clear_pending');
      projected = projectAssistantEvent(projected, event, session, running);
    }
  });
  return { messages: dedupeChatMessages(projected), effects };
}

function appendUserMessage(messages: ChatMessage[], event: SessionEventItem): ChatMessage[] {
  const content = String(event.content || '').trim();
  const timestamp = event.timestamp;
  const duplicate = messages.some((item) => item.role === 'user'
    && String(item.timestamp || '') === String(timestamp || '')
    && String(item.content || '').trim() === content);
  return duplicate ? messages : [
    ...messages,
    {
      role: 'user',
      content,
      images: Array.isArray(event.images) ? event.images : [],
      timestamp,
    },
  ];
}

function projectAssistantEvent(
  messages: ChatMessage[],
  event: SessionEventItem,
  session: Session,
  pending: boolean,
): ChatMessage[] {
  return applySessionAssistantEvent(messages, event, {
    pending,
    provider: session.provider,
    model: event.model,
    thinkingStatusText: getThinkingStatusText(session.provider),
    processingStatusText: getProcessingStatusText(),
  });
}
