import { getThinkingStatusText } from './provider-pending-policy.js';

export function appendThinkingChunk(currentContent, thinkingChunk) {
  const safeChunk = String(thinkingChunk || '');
  if (!safeChunk) return String(currentContent || '');

  const base = String(currentContent || '');
  const closeMarker = '\n:::\n';
  const marker = ':::thinking\n';
  const thinkingStart = base.indexOf(marker);
  if (thinkingStart >= 0) {
    const thinkingBodyStart = thinkingStart + marker.length;
    const thinkingEnd = base.indexOf(closeMarker, thinkingBodyStart);
    if (thinkingEnd >= 0) {
      const before = base.slice(0, thinkingBodyStart);
      const currentThinking = base.slice(thinkingBodyStart, thinkingEnd);
      const after = base.slice(thinkingEnd);
      return `${before}${currentThinking}${safeChunk}${after}`;
    }
  }

  return `${base}${base ? '\n' : ''}:::thinking\n${safeChunk}\n:::\n`;
}

export function stripThinkingBlock(content) {
  const base = String(content || '');
  return base
    .replace(/\n?:::thinking\n[\s\S]*?\n:::\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decorateMessagesWithPendingState({
  messages,
  loading,
  externalPending,
  loadingStatusText,
  externalPendingStatusText,
  activeProvider,
  pendingTimestamp
}) {
  const baseMessages = Array.isArray(messages) ? messages : [];
  const hasPendingAssistant = baseMessages.some((msg) => msg.role === 'assistant' && msg.pending);
  const shouldShowSyntheticPending = Boolean(loading || externalPending) && !hasPendingAssistant;

  if (!shouldShowSyntheticPending) {
    return {
      messages: baseMessages,
      usedSyntheticPending: false
    };
  }

  const pendingStatusText = loadingStatusText
    || externalPendingStatusText
    || getThinkingStatusText(activeProvider);

  const nextMessages = [...baseMessages];
  const last = nextMessages[nextMessages.length - 1];
  if (last && last.role === 'assistant') {
    nextMessages[nextMessages.length - 1] = {
      ...last,
      pending: true,
      statusText: pendingStatusText,
      timestamp: last.timestamp || pendingTimestamp
    };
    return {
      messages: nextMessages,
      usedSyntheticPending: true
    };
  }

  return {
    messages: nextMessages,
    usedSyntheticPending: false
  };
}
