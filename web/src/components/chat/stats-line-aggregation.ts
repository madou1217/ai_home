import type { ChatMessage } from '@/types';

export interface SessionStats {
  turns: number;
  assistantCount: number;
  totalDurationMs: number;
  avgDuration: number;
  avgTtft: number;
  avgTps: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  hasData: boolean;
}

/**
 * StatsLine 会话度量聚合（纯函数，从组件抽离以便基准测试）。
 * 遍历历史消息汇总轮次/总耗时/首字/速度/Token 用量。
 */
export function aggregateSessionStats(messages: ChatMessage[]): SessionStats {
  let turns = 0;
  let assistantCount = 0;
  let totalDurationMs = 0;
  let totalTtftMs = 0;
  let ttftCount = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      turns += 1;
    } else if (msg.role === 'assistant') {
      assistantCount += 1;
      if (msg.metrics?.durationMs) {
        totalDurationMs += msg.metrics.durationMs;
      }
      if (msg.metrics?.ttftMs) {
        totalTtftMs += msg.metrics.ttftMs;
        ttftCount += 1;
      }
      if (msg.metrics?.outputTokens) {
        totalOutputTokens += msg.metrics.outputTokens;
      }
      if (msg.metrics?.inputTokens) {
        totalInputTokens += msg.metrics.inputTokens;
      }
    }
  }

  const avgDuration = assistantCount > 0 && totalDurationMs > 0 ? totalDurationMs / assistantCount : 0;
  const avgTtft = ttftCount > 0 ? totalTtftMs / ttftCount : 0;
  const avgTps = totalDurationMs > 0 && totalOutputTokens > 0 ? totalOutputTokens / (totalDurationMs / 1000) : 0;

  return {
    turns,
    assistantCount,
    totalDurationMs,
    avgDuration,
    avgTtft,
    avgTps,
    totalOutputTokens,
    totalInputTokens,
    hasData: assistantCount > 0 && (totalDurationMs > 0 || totalOutputTokens > 0),
  };
}
