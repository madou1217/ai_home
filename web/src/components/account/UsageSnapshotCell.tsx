import { useState } from 'react';
import { Button, Progress } from 'antd';
import type {
  AccountUsageSnapshot,
  CodexUsageEntry,
  GeminiUsageModel
} from '@/types';

interface UsageRecordLike {
  configured?: boolean;
  apiKeyMode?: boolean;
  provider?: string;
  remainingPct?: number | null;
  usageSnapshot?: AccountUsageSnapshot | null;
}

function formatUsagePercent(value: number | null) {
  return value == null ? '-' : `${value.toFixed(1)}%`;
}

function getUsageBarColor(value: number | null) {
  if (value == null) return '#d9d9d9';
  if (value > 80) return '#52c41a';
  if (value > 30) return '#faad14';
  return '#ff4d4f';
}

function orderCodexEntries(entries: CodexUsageEntry[]) {
  const priority = new Map([
    ['5h', 0],
    ['7days', 1]
  ]);
  return [...entries].sort((a, b) => {
    const aPriority = priority.has(a.window) ? priority.get(a.window)! : 99;
    const bPriority = priority.has(b.window) ? priority.get(b.window)! : 99;
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aWindow = Number(a.windowMinutes) || 0;
    const bWindow = Number(b.windowMinutes) || 0;
    if (aWindow !== bWindow) return aWindow - bWindow;
    return String(a.window || '').localeCompare(String(b.window || ''));
  });
}

function orderGeminiModels(models: GeminiUsageModel[]) {
  return [...models].sort((a, b) => {
    const aRemaining = a.remainingPct == null ? 101 : a.remainingPct;
    const bRemaining = b.remainingPct == null ? 101 : b.remainingPct;
    if (aRemaining !== bRemaining) return aRemaining - bRemaining;
    return String(a.model || '').localeCompare(String(b.model || ''));
  });
}

function UsageMetaLine({ label, value, resetIn }: { label: string; value: number | null; resetIn?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: '#595959', fontSize: 'clamp(12.5px, 3.2vw, 13.5px)', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ textAlign: 'right', minWidth: 0, color: '#8c8c8c', fontSize: 'clamp(11.5px, 3vw, 12.5px)' }}>
          {resetIn || ''}
        </span>
      </div>
      <Progress
        percent={Math.max(0, Math.min(100, Number(value || 0)))}
        size="small"
        strokeColor={getUsageBarColor(value)}
        trailColor="#f0f0f0"
        format={() => formatUsagePercent(value)}
      />
    </div>
  );
}

export default function UsageSnapshotCell({ record }: { record: UsageRecordLike }) {
  const [expanded, setExpanded] = useState(false);

  if (!record.configured) return <>-</>;
  if (record.apiKeyMode) return <>-</>;

  const snapshot = record.usageSnapshot;

  if (record.provider === 'codex' && snapshot?.kind === 'codex_oauth_status') {
    const entries = orderCodexEntries((snapshot.entries || []).filter((entry) => entry.remainingPct != null));
    if (entries.length === 0) return <>-</>;
    const visibleEntries = expanded ? entries : entries.slice(0, 2);
    return (
      <div style={{ minWidth: 180 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleEntries.map((entry, index) => (
            <UsageMetaLine
              key={`${entry.window}-${index}`}
              label={entry.window || entry.bucket || 'usage'}
              value={entry.remainingPct}
              resetIn={entry.resetIn}
            />
          ))}
        </div>
        {entries.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${entries.length - 2} 项`}
          </Button>
        ) : null}
      </div>
    );
  }

  if (record.provider === 'gemini' && snapshot?.kind === 'gemini_oauth_stats') {
    const models = orderGeminiModels((snapshot.models || []).filter((model) => model.remainingPct != null));
    if (models.length === 0) return <>-</>;
    const visibleModels = expanded ? models : models.slice(0, 2);
    return (
      <div style={{ minWidth: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleModels.map((model, index) => (
            <UsageMetaLine
              key={`${model.model}-${index}`}
              label={model.model || 'model'}
              value={model.remainingPct}
              resetIn={model.resetIn}
            />
          ))}
        </div>
        {models.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${models.length - 2} 个模型`}
          </Button>
        ) : null}
      </div>
    );
  }

  if (record.remainingPct == null) return <>-</>;
  return (
    <Progress
      percent={Math.max(0, Math.min(100, Number(record.remainingPct || 0)))}
      size="small"
      strokeColor={getUsageBarColor(record.remainingPct)}
      trailColor="#f0f0f0"
      format={() => formatUsagePercent(record.remainingPct ?? null)}
    />
  );
}
