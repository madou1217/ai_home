import { memo, useMemo } from 'react';
import type { ChatMessage } from '@/types';
import ConnectionPulseBadge from './ConnectionPulseBadge';
import { formatDurationLabel, formatTtftLabel, formatTokensPerSecLabel } from './message-metrics-format';
import styles from './chat.module.css';

interface StatsLineProps {
  messages: ChatMessage[];
  className?: string;
}

export function formatTokensCompact(n: number): string {
  if (!n || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}m`;
}

export const StatsLine = memo(function StatsLine({ messages, className = '' }: StatsLineProps) {
  const stats = useMemo(() => {
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
    const avgTps = totalDurationMs > 0 && totalOutputTokens > 0 ? (totalOutputTokens / (totalDurationMs / 1000)) : 0;

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
  }, [messages]);

  if (!stats.hasData) return null;

  const parts: string[] = [];
  parts.push(`${stats.turns} 轮对话`);
  if (stats.totalDurationMs > 0) {
    parts.push(`总用时 ${formatDurationLabel(stats.totalDurationMs)}`);
  }
  if (stats.avgTtft > 0) {
    parts.push(`平均首字 ${formatTtftLabel(stats.avgTtft)}`);
  }
  if (stats.avgTps > 0) {
    parts.push(`平均 ${formatTokensPerSecLabel(stats.avgTps)}`);
  }
  if (stats.totalOutputTokens > 0) {
    parts.push(`输出 ${formatTokensCompact(stats.totalOutputTokens)} tok`);
  }

  return (
    <div className={`${styles.statsLineContainer} ${className}`} title={parts.join(' · ')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={styles.statsLineIcon}>⚡</span>
        <span className={styles.statsLineText}>
          {parts.map((p, idx) => (
            <span key={p} className={styles.statsLinePart}>
              {idx > 0 && <span className={styles.statsLineDivider}>·</span>}
              {p}
            </span>
          ))}
        </span>
      </div>
      <ConnectionPulseBadge status="connected" latencyMs={28} />
    </div>
  );
});

export default StatsLine;
