import type { ChatAccount, ChatMessage, Session } from '@/types';
import { dedupeChatMessages } from './message-history-policy';
import { legacySessionCacheKey } from './legacy-session-history-state';

export function buildInitialRunMessages(
  history: ChatMessage[],
  content: string,
  images: string[],
  options: { clock?: () => number; model?: string } = {},
): ChatMessage[] {
  const clock = options.clock || Date.now;
  const model = String(options.model || '').trim();
  const modelMetadata = model ? { model } : {};
  return dedupeChatMessages([
    ...history,
    {
      role: 'user',
      content: content.trim(),
      images: images.slice(),
      timestamp: clock(),
      ...modelMetadata,
    },
    {
      role: 'assistant',
      content: '',
      pending: true,
      statusText: '已发送，正在连接...',
      timestamp: clock(),
      ...modelMetadata,
    },
  ]);
}

export function buildStatelessRequestMessages(messages: ChatMessage[]) {
  return messages
    .filter((item) => item.role === 'user' || item.role === 'assistant' || item.role === 'system')
    .filter((item) => !(item.role === 'assistant' && !String(item.content || '').trim()))
    .map((item) => ({ role: item.role, content: item.content }));
}

export function usesNativeSession(account: ChatAccount): boolean {
  return (account.provider === 'claude'
    || account.provider === 'codex'
    || account.provider === 'gemini')
    && !account.apiKeyMode;
}

export function isSameVisibleSession(current: Session | null, expected: Session): boolean {
  return Boolean(current && legacySessionCacheKey(current) === legacySessionCacheKey(expected));
}

export function removePendingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const next = messages.slice();
  const last = next[next.length - 1];
  if (last?.role === 'assistant' && last.pending) next.pop();
  return next;
}

export function finalizePendingAssistantFailure(
  messages: ChatMessage[],
  failureText: string,
  clock: () => number = Date.now,
): ChatMessage[] {
  const content = `请求失败：${String(failureText || '未知错误').trim() || '未知错误'}`;
  const next = messages.slice();
  const last = next[next.length - 1];
  if (last?.role === 'assistant' && last.pending) {
    next[next.length - 1] = {
      ...last,
      content: [String(last.content || '').trim(), content].filter(Boolean).join('\n\n'),
      pending: false,
      statusText: undefined,
    };
    return next;
  }
  next.push({ role: 'assistant', content, pending: false, timestamp: clock() });
  return next;
}
