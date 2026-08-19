import { useState } from 'react';
import { message, Progress, Space, Spin, Tooltip } from 'antd';
import type {
  AccountUsageSnapshot,
  CodexUsageEntry,
  GeminiUsageModel
} from '@/types';
import Button from '@/components/ui/AppButton';
import {
  formatResetAt,
  formatResetIn,
  formatWindowDuration,
  groupAgyQuotaModels,
  type AgyGroupMemberModel
} from './usage-snapshot-format';

interface UsageRecordLike {
  configured?: boolean;
  apiKeyMode?: boolean;
  provider?: string;
  remainingPct?: number | null;
  usageSnapshot?: AccountUsageSnapshot | null;
  usageRefreshing?: boolean;
}

function formatUsagePercent(value: number | null) {
  return value == null ? '-' : `${value.toFixed(1)}%`;
}

export function getUsageBarColor(value: number | null) {
  if (value == null) return '#d9d9d9';
  if (value > 80) return '#52c41a';
  if (value > 30) return '#faad14';
  return '#ff4d4f';
}

function orderCodexEntries(entries: CodexUsageEntry[]) {
  return [...entries].sort((a, b) => {
    const aWindowValue = Number(a.windowMinutes);
    const bWindowValue = Number(b.windowMinutes);
    const aWindow = Number.isFinite(aWindowValue) && aWindowValue > 0 ? aWindowValue : Number.POSITIVE_INFINITY;
    const bWindow = Number.isFinite(bWindowValue) && bWindowValue > 0 ? bWindowValue : Number.POSITIVE_INFINITY;
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

function CopyableModelId({ modelId }: { modelId: string }) {
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(modelId);
      } else {
        const input = document.createElement('input');
        input.value = modelId;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      message.success({ content: `已复制: ${modelId}`, duration: 1.5, key: 'copy-model-id' });
    } catch (_err) {
      message.error({ content: '复制失败', duration: 1.5 });
    }
  };

  return (
    <span
      onClick={handleCopy}
      title="点击复制模型 ID"
      style={{
        color: 'rgba(255, 255, 255, 0.75)',
        cursor: 'pointer',
        fontSize: 11.5,
        fontFamily: 'var(--font-mono, monospace)',
        wordBreak: 'break-all',
        transition: 'color 0.15s ease',
        userSelect: 'all',
        textAlign: 'left'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = '#91caff';
        e.currentTarget.style.textDecoration = 'underline';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'rgba(255, 255, 255, 0.75)';
        e.currentTarget.style.textDecoration = 'none';
      }}
    >
      {modelId}
    </span>
  );
}

function AgyGroupModelsTooltip({
  members
}: {
  members: AgyGroupMemberModel[];
}) {
  const [showAll, setShowAll] = useState(false);
  const maxInitial = 8;
  const isLargeList = members.length > maxInitial;
  const visibleMembers = (isLargeList && !showAll) ? members.slice(0, maxInitial) : members;

  return (
    <div style={{ minWidth: 320, maxWidth: 540, padding: '2px 0' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, auto) 1fr',
          alignItems: 'center',
          gap: 16,
          paddingBottom: 5,
          marginBottom: 6,
          borderBottom: '1px solid rgba(255, 255, 255, 0.18)',
          fontSize: 11,
          color: 'rgba(255, 255, 255, 0.65)'
        }}
      >
        <span style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>名称 ({members.length})</span>
        <span style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>模型 ID</span>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxHeight: showAll ? 280 : 190,
          overflowY: 'auto',
          paddingRight: 4
        }}
      >
        {visibleMembers.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(140px, auto) 1fr',
              alignItems: 'center',
              gap: 16
            }}
          >
            <span
              style={{
                color: '#fff',
                textAlign: 'left',
                fontWeight: 500,
                fontSize: 11.5,
                whiteSpace: 'nowrap'
              }}
            >
              {m.name}
            </span>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <CopyableModelId modelId={m.id} />
            </div>
          </div>
        ))}
      </div>
      {isLargeList ? (
        <div
          style={{
            marginTop: 6,
            paddingTop: 4,
            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
            textAlign: 'center',
            cursor: 'pointer',
            color: '#4096ff',
            fontSize: 11
          }}
          onClick={(e) => {
            e.stopPropagation();
            setShowAll((curr) => !curr);
          }}
        >
          {showAll ? '收起列表 ▲' : `展开全部 (${members.length}) ▼`}
        </div>
      ) : null}
    </div>
  );
}

function UsageMetaLine({
  label,
  value,
  resetIn,
  resetAtMs
}: {
  label: string;
  value: number | null;
  resetIn?: string;
  resetAtMs?: number;
}) {
  const resetInLabel = formatResetIn(resetIn, resetAtMs);
  const resetLabel = formatResetAt(resetAtMs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: '#595959', fontSize: 'clamp(12.5px, 3.2vw, 13.5px)', whiteSpace: 'nowrap' }}>{label}</span>
        {resetInLabel ? (
          <span style={{ textAlign: 'right', minWidth: 0, color: '#8c8c8c', fontSize: 'clamp(11.5px, 3vw, 12.5px)', whiteSpace: 'nowrap' }}>
            {resetInLabel}
          </span>
        ) : null}
      </div>
      <Progress
        percent={Math.max(0, Math.min(100, Number(value || 0)))}
        size="small"
        strokeColor={getUsageBarColor(value)}
        trailColor="#f0f0f0"
        format={() => formatUsagePercent(value)}
      />
      {resetLabel ? (
        <div style={{ color: '#8c8c8c', fontSize: 'clamp(11.5px, 3vw, 12.5px)', whiteSpace: 'nowrap' }}>
          {resetLabel}
        </div>
      ) : null}
    </div>
  );
}

export default function UsageSnapshotCell({ record, hideModels = false }: { record: UsageRecordLike; hideModels?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!record.configured) return <>-</>;
  if (record.apiKeyMode) return <>-</>;

  const snapshot = record.usageSnapshot;

  if (
    (record.provider === 'codex' && snapshot?.kind === 'codex_oauth_status')
    || (record.provider === 'claude' && snapshot?.kind === 'claude_oauth_usage')
    || (record.provider === 'kimi' && snapshot?.kind === 'kimi_oauth_usage')
  ) {
    const entries = orderCodexEntries(
      // The upstream snapshot is the source of truth: any window with a
      // numeric remaining value is renderable, including provider-specific
      // windows such as Codex Free's 30-day quota.
      (snapshot.entries || []).filter((entry) => typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct))
    );
    if (entries.length === 0) {
      return record.usageRefreshing ? (
        <Space size={6}>
          <span>-</span>
          <Spin size="small" />
        </Space>
      ) : <>-</>;
    }
    const visibleEntries = hideModels ? entries.slice(0, 1) : (expanded ? entries : entries.slice(0, 2));
    return (
      <div style={{ minWidth: 180 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleEntries.map((entry, index) => (
            <UsageMetaLine
              key={`${entry.window}-${index}`}
              label={formatWindowDuration(entry.windowMinutes, entry.window) || entry.bucket || 'usage'}
              value={entry.remainingPct}
              resetIn={entry.resetIn}
              resetAtMs={entry.resetAtMs}
            />
          ))}
        </div>
        {!hideModels && entries.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${entries.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spin size="small" />
            <span>刷新中</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (record.provider === 'zcode' && snapshot?.kind === 'zcode_plan_balance') {
    // zcode 的 entries 是「按模型分桶」的余额（bucket = 模型 ID，window 多为 1days），
    // 渲染成套餐分组（仿 agy）：组标题 = plan 名，行 = 模型 + 窗口。
    const entries = orderCodexEntries(
      (snapshot.entries || []).filter((entry) => typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct))
    );
    if (entries.length === 0) {
      return record.usageRefreshing ? (
        <Space size={6}>
          <span>-</span>
          <Spin size="small" />
        </Space>
      ) : <>-</>;
    }
    const planName = snapshot.account?.planType || '';
    const visibleEntries = hideModels ? entries.slice(0, 1) : (expanded ? entries : entries.slice(0, 2));
    return (
      <div style={{ minWidth: 200 }}>
        {planName ? (
          <div
            style={{
              fontWeight: 600,
              fontSize: 'clamp(12px, 3vw, 12.5px)',
              color: '#334155',
              letterSpacing: '0.15px',
              marginBottom: 4
            }}
          >
            {planName}
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleEntries.map((entry, index) => {
            const windowLabel = formatWindowDuration(entry.windowMinutes, entry.window) || entry.window || '';
            const label = entry.bucket
              ? (windowLabel ? `${entry.bucket} · ${windowLabel}` : entry.bucket)
              : (windowLabel || 'usage');
            return (
              <UsageMetaLine
                key={`${entry.bucket}-${entry.window}-${index}`}
                label={label}
                value={entry.remainingPct}
                resetIn={entry.resetIn}
                resetAtMs={entry.resetAtMs}
              />
            );
          })}
        </div>
        {!hideModels && entries.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${entries.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spin size="small" />
            <span>刷新中</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (record.provider === 'agy' && snapshot?.kind === 'agy_code_assist_quota') {
    const groups = groupAgyQuotaModels(snapshot.models || []);
    if (groups.length === 0) return <>-</>;

    return (
      <div style={{ minWidth: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map((group) => {
            const visibleLimits = hideModels
              ? group.limits.slice(0, 1)
              : group.limits.slice(0, 2);

            return (
              <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Tooltip
                    overlayClassName="token-usage-tooltip-overlay"
                    title={<AgyGroupModelsTooltip members={group.members} />}
                    placement="topLeft"
                  >
                    <span
                      style={{
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
                        fontWeight: 600,
                        fontSize: 'clamp(12px, 3vw, 12.5px)',
                        color: '#334155',
                        letterSpacing: '0.15px',
                        cursor: 'help',
                        borderBottom: '1px dotted #94a3b8'
                      }}
                    >
                      {group.title}
                    </span>
                  </Tooltip>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {visibleLimits.map((limit, index) => (
                    <UsageMetaLine
                      key={`${limit.key}-${index}`}
                      label={limit.label}
                      value={limit.remainingPct}
                      resetIn={limit.resetIn}
                      resetAtMs={limit.resetAtMs}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spin size="small" />
            <span>刷新中</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (record.provider === 'gemini' && snapshot?.kind === 'gemini_oauth_stats') {
    const models = orderGeminiModels((snapshot.models || []).filter((model) => model.remainingPct != null));
    if (models.length === 0) return <>-</>;
    const visibleModels = hideModels ? models.slice(0, 1) : (expanded ? models : models.slice(0, 2));
    return (
      <div style={{ minWidth: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleModels.map((model, index) => (
            <UsageMetaLine
              key={`${model.model}-${index}`}
              label={model.model || 'model'}
              value={model.remainingPct}
              resetIn={model.resetIn}
              resetAtMs={model.resetAtMs}
            />
          ))}
        </div>
        {!hideModels && models.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${models.length - 2} 个模型`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spin size="small" />
            <span>刷新中</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (record.remainingPct == null) {
    return record.usageRefreshing ? (
      <Space size={6}>
        <span>-</span>
        <Spin size="small" />
      </Space>
    ) : <>-</>;
  }
  return (
    <div>
      <Progress
        percent={Math.max(0, Math.min(100, Number(record.remainingPct || 0)))}
        size="small"
        strokeColor={getUsageBarColor(record.remainingPct)}
        trailColor="#f0f0f0"
        format={() => formatUsagePercent(record.remainingPct ?? null)}
      />
      {record.usageRefreshing ? (
        <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spin size="small" />
          <span>刷新中</span>
        </div>
      ) : null}
    </div>
  );
}
