import type { ChatMessage } from '@/types';

// 高水位 60%:与服务端自动压缩阈值(lib/server/webui-chat-routes-opencode-proxy.js)保持一致
export const CONTEXT_WARNING_THRESHOLD_PERCENT = 60;
export const CONTEXT_CRITICAL_THRESHOLD_PERCENT = 90;
export const DEFAULT_CONTEXT_MAX_TOKENS = 128000;

export interface ContextStats {
  usedTokens: number;
  contextWindow: number;
  percent: number;
  isWarning: boolean;
  isCritical: boolean;
}

export function estimateContextTokens(messages: ChatMessage[]): number {
  let totalOutput = 0;
  let totalInput = 0;
  for (const msg of messages) {
    if (msg.metrics?.outputTokens) totalOutput += msg.metrics.outputTokens;
    if (msg.metrics?.inputTokens) totalInput += msg.metrics.inputTokens;
  }
  // 估算当前对话累积 token:未带精确 metrics 时按字符粗算 (~1.5 字符/token)
  const approxTotal = totalOutput + totalInput;
  if (approxTotal === 0 && messages.length > 0) {
    const charCount = messages.reduce((acc, m) => acc + String(m.content || '').length, 0);
    return Math.round(charCount / 1.5);
  }
  return approxTotal;
}

export function computeContextStats(
  messages: ChatMessage[],
  maxTokens: number = DEFAULT_CONTEXT_MAX_TOKENS,
): ContextStats {
  const usedTokens = estimateContextTokens(messages);
  const percent = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  return {
    usedTokens,
    contextWindow: maxTokens,
    percent,
    isWarning: percent >= CONTEXT_WARNING_THRESHOLD_PERCENT,
    isCritical: percent >= CONTEXT_CRITICAL_THRESHOLD_PERCENT,
  };
}
