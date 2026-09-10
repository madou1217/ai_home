import { useEffect, useState } from 'react';
import { useSessionSelector, type SessionProjection, type SessionProjectionStore } from '@/chat-runtime';
import { formatDurationLabel, formatTtftLabel } from '@/components/chat/message-metrics-format';
import { turnProgressText } from './turn-feedback-policy';

export default function TurnProgress({ store }: { readonly store: SessionProjectionStore }) {
  const projection = useSessionSelector(store, selectProgress);
  const [now, setNow] = useState(Date.now);
  const active = Boolean(projection.activeTurn);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, projection.activeTurn?.turnId]);
  const progress = turnProgressText(projection, now);
  if (!progress) return null;
  const turn = projection.activeTurn;
  const duration = turn?.startedAt === undefined ? '' : formatDurationLabel(Math.max(0, now - turn.startedAt));
  const ttft = turn?.startedAt !== undefined && turn.firstTokenAt !== undefined
    ? formatTtftLabel(Math.max(0, turn.firstTokenAt - turn.startedAt)) : '';
  return <span role="status" aria-live="off" data-turn-progress={turn?.turnId}>
    {projection.items.at(-1)?.kind === 'reasoning' && projection.state === 'running' ? '思考中' : progress.split(' · ')[0]}
    {duration ? ` · ${duration}` : ''}{ttft ? ` · 首字 ${ttft}` : ''}
  </span>;
}

function selectProgress(projection: SessionProjection): SessionProjection { return projection; }
