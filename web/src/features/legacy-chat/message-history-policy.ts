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

function areDuplicateUserMessages(left?: ChatMessage, right?: ChatMessage): boolean {
  if (!left || !right || left.role !== 'user' || right.role !== 'user') return false;
  if (normalizeMessageText(left.content) !== normalizeMessageText(right.content)) return false;

  const leftImages = normalizeMessageImages(left.images);
  const rightImages = normalizeMessageImages(right.images);
  if (leftImages.length !== rightImages.length) return false;
  if (leftImages.some((item, index) => item !== rightImages[index])) return false;

  const leftTime = messageTimeMs(left.timestamp);
  const rightTime = messageTimeMs(right.timestamp);
  return !leftTime || !rightTime || Math.abs(leftTime - rightTime) <= 30 * 1000;
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
  return {
    ...previous,
    images: (current.images || []).length > 0 ? current.images : previous.images,
    timestamp: current.timestamp || previous.timestamp,
    model: current.model || previous.model,
  };
}
