import { useMemo } from 'react';
import { useSessionSelector, type SessionProjection, type SessionProjectionStore } from '@/chat-runtime';
import StatsLine from '@/components/chat/StatsLine';
import ContextMeter from '@/components/chat/ContextMeter';
import type { ChatMessage } from '@/types';

export default function SessionMetrics({ store, onCompact }: {
  readonly store: SessionProjectionStore;
  readonly onCompact: () => void;
}) {
  const projection = useSessionSelector(store, selectProjection);
  const messages = useMemo(() => projection.items.flatMap((item): ChatMessage[] => item.kind === 'message'
    ? [{ role: item.detail.role, content: item.content || '', metrics: item.detail.metrics }]
    : item.kind === 'reasoning' && item.detail.metrics
      ? [{ role: 'assistant', content: '', metrics: item.detail.metrics }] : []), [projection.items]);
  // After compaction, wait for a fresh usage report instead of showing the old context size.
  const latestContext = projection.items.findLast((item) =>
    (item.kind === 'message' || item.kind === 'reasoning') && item.detail.metrics?.contextTokens !== undefined
      || item.kind === 'notice' && ['contextCompaction', 'context_compacted'].includes(item.detail.code || ''));
  const lastMetrics = latestContext?.kind === 'notice' ? undefined : latestContext?.detail;
  const metrics = { ...(lastMetrics && 'metrics' in lastMetrics ? lastMetrics.metrics : {}), ...projection.activeTurn?.metrics };
  const context = projection.policy.contextState as { usedTokens?: number; contextWindow?: number; stale?: boolean;
    compaction?: { status: string } } | undefined;
  const window = context?.contextWindow || metrics.contextWindow;
  const used = context ? context.usedTokens : metrics.contextTokens;
  const status = context?.compaction?.status;
  const contextMeter = <>
    {status === 'running' ? <span role="status">正在压缩…</span>
      : status === 'failed' ? <span role="status">压缩失败，可重试</span>
        : status === 'cancelled' ? <span role="status">压缩已停止</span>
          : context?.stale ? <span title="下一轮收到用量后更新占用">上下文已压缩</span> : null}
    {!context?.stale && window && used !== undefined ? <ContextMeter
      messages={[]} maxTokens={window} usedTokens={used}
      onCompactSuggest={projection.state === 'idle' ? onCompact : undefined} /> : null}
  </>;
  return <StatsLine messages={messages} showConnection={false} partial={projection.timelineHasMore}
    embedded trailing={contextMeter} />;
}

function selectProjection(projection: SessionProjection): SessionProjection { return projection; }
