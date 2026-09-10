import { memo, useMemo, useState, useEffect, type ReactNode } from 'react';
import type { ChatMessage } from '@/types';
import ConnectionPulseBadge from './ConnectionPulseBadge';
import { formatDurationLabel, formatTtftLabel, formatTokensPerSecLabel } from './message-metrics-format';
import { aggregateSessionStats } from './stats-line-aggregation';
import { realLatencyTracker } from '@/services/real-latency-tracker';
import styles from './composer/composer.module.css';

interface StatsLineProps {
  messages: ChatMessage[];
  className?: string;
  showConnection?: boolean;
  partial?: boolean;
  embedded?: boolean;
  trailing?: ReactNode;
}

export function formatTokensCompact(n: number): string {
  if (!n || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}m`;
}

export const StatsLine = memo(function StatsLine({ messages, className = '', showConnection = true, partial = false, embedded = false, trailing }: StatsLineProps) {
  const [realLatency, setRealLatency] = useState<number | null>(() => realLatencyTracker.getLatency());

  useEffect(() => {
    return realLatencyTracker.subscribe((lat) => {
      setRealLatency(lat);
    });
  }, []);

  const stats = useMemo(() => aggregateSessionStats(messages), [messages]);

  if (!stats.hasData && !trailing) return null;

  const parts: string[] = [];
  if (partial) parts.push('已加载记录');
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

  const connectionStatus = realLatency !== null ? 'connected' : 'reconnecting';

  return (
    <div className={`${embedded ? styles.statsLineEmbedded : styles.statsLineContainer} ${className}`} title={parts.join(' · ')}>
      {stats.hasData ? <div className={styles.statsLineSummary}>
        <span className={styles.statsLineIcon}>⚡</span>
        <span className={styles.statsLineText}>
          {parts.map((p, idx) => (
            <span key={p} className={styles.statsLinePart}>
              {idx > 0 && <span className={styles.statsLineDivider}>·</span>}
              {p}
            </span>
          ))}
        </span>
      </div> : null}
      {trailing}
      {showConnection ? <ConnectionPulseBadge
        status={connectionStatus}
        latencyMs={realLatency || undefined}
      /> : null}
    </div>
  );
});

export default StatsLine;
