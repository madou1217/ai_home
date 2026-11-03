function hasRenderableImages(message) {
  return Array.isArray(message && message.images) && message.images.some(Boolean);
}

export function isRenderableChatMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.role !== 'assistant') return true;
  if (message.pending) return true;
  if (hasRenderableImages(message)) return true;
  return Boolean(String(message.content || '').trim());
}

export function filterRenderableChatMessages(messages) {
  return Array.isArray(messages) ? messages.filter(isRenderableChatMessage) : [];
}
