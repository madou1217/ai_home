import { getThinkingStatusText } from './provider-pending-policy.js';

export function resolvePendingTailState({
  messages,
  loading,
  externalPending,
  loadingStatusText,
  externalPendingStatusText,
  activeProvider
}) {
  const baseMessages = Array.isArray(messages) ? messages : [];
  const hasPendingAssistant = baseMessages.some((message) => message.role === 'assistant' && message.pending);
  const shouldShowTail = Boolean(loading || externalPending) && !hasPendingAssistant;

  if (!shouldShowTail) {
    return {
      visible: false,
      statusText: ''
    };
  }

  return {
    visible: true,
    statusText: loadingStatusText
      || externalPendingStatusText
      || getThinkingStatusText(activeProvider)
  };
}
