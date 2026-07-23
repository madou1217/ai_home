import { applySessionAssistantEvent } from '@/components/chat/assistant-event-adapter.js';
import {
  getProcessingStatusText,
  getThinkingStatusText,
} from '@/components/chat/provider-pending-policy.js';
import type { ChatMessage, Session, SessionEventItem } from '@/types';
import { normalizeMessageText } from '@/pages/chat-notification.js';
import { areCloseTimestamps, dedupeChatMessages } from './message-history-policy';

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
  const images = Array.isArray(event.images) ? event.images : [];
  const source = event.source as ChatMessage['source'];
  const duplicateIndex = messages.findIndex((item) => item.role === 'user'
    && normalizeMessageText(item.content) === normalizeMessageText(content)
    && areCloseTimestamps(item.timestamp, timestamp));

  if (duplicateIndex === -1) {
    return [
      ...messages,
      {
        role: 'user',
        content,
        images,
        timestamp,
        ...(source ? { source } : {}),
      },
    ];
  }

  const existing = messages[duplicateIndex];
  const merged: ChatMessage = {
    ...existing,
    images: images.length > 0 ? images : existing.images,
    timestamp: timestamp || existing.timestamp,
    source: source || existing.source,
  };
  return messages.map((item, index) => (index === duplicateIndex ? merged : item));
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
