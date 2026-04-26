export function normalizeMessageText(value) {
  return String(value || '').trim();
}

export function shouldNotifyAssistantCompleted(options = {}) {
  if (options.permission !== 'granted') return false;
  const visibilityState = String(options.visibilityState || '');
  const hasFocus = options.hasFocus;
  return visibilityState !== 'visible' || hasFocus === false;
}

export function buildAssistantCompletionNotification(provider, content, providerNameMap = {}) {
  const providerLabel = providerNameMap[provider] || provider || 'AI';
  const body = normalizeMessageText(content).slice(0, 120) || '回复已完成，点击返回查看';
  return {
    title: `${providerLabel} 已完成`,
    body
  };
}
