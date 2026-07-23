import type { ChatMessage } from '@/types';
import { normalizeMessageText } from '@/pages/chat-notification.js';

function normalizeMessageImages(images?: string[]): string[] {
  const seen = new Set<string>();
  return (Array.isArray(images) ? images : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function messageTimeMs(timestamp?: string | number): number {
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp !== 'string') return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function areCloseTimestamps(
  left?: string | number,
  right?: string | number,
  toleranceMs = 30 * 1000,
): boolean {
  const leftTime = messageTimeMs(left);
  const rightTime = messageTimeMs(right);
  return !leftTime || !rightTime || Math.abs(leftTime - rightTime) <= toleranceMs;
}

function areDuplicateUserMessages(left?: ChatMessage, right?: ChatMessage): boolean {
  if (!left || !right || left.role !== 'user' || right.role !== 'user') return false;
  if (normalizeMessageText(left.content) !== normalizeMessageText(right.content)) return false;
  return areCloseTimestamps(left.timestamp, right.timestamp);
}

export function dedupeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const current = normalizeChatMessage(message);
    const previous = deduped[deduped.length - 1];
    if (!areDuplicateUserMessages(previous, current)) {
      deduped.push(current);
      continue;
    }
    deduped[deduped.length - 1] = mergeDuplicateUserMessage(previous, current);
  }
  return deduped;
}

export function isPureSessionHistoryAppend(
  previous: ChatMessage[],
  next: ChatMessage[],
): boolean {
  if (next.length <= previous.length) return false;
  return previous.every((message, index) => {
    const candidate = next[index];
    return Boolean(candidate
      && message.role === candidate.role
      && normalizeMessageText(message.content) === normalizeMessageText(candidate.content)
      && String(message.timestamp || '') === String(candidate.timestamp || ''));
  });
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: normalizeMessageText(message.content),
    images: normalizeMessageImages(message.images),
  };
}

function mergeDuplicateUserMessage(previous: ChatMessage, current: ChatMessage): ChatMessage {
  const model = current.model || previous.model;
  const source = current.source || previous.source;
  return {
    ...previous,
    images: (current.images || []).length > 0 ? current.images : previous.images,
    timestamp: current.timestamp || previous.timestamp,
    ...(model ? { model } : {}),
    ...(source ? { source } : {}),
  };
}
