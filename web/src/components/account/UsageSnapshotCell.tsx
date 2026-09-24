import { useState } from 'react';
import { message, Progress, Space, Spin, Tooltip } from 'antd';
import type {
  AccountUsageSnapshot,
  CodexUsageEntry,
  GeminiUsageModel
} from '@/types';
import Button from '@/components/ui/AppButton';
import BurningParticles from '@/features/accounts/BurningParticles';
import {
  buildCodebuddyCreditRows,
  buildUsageUnitsTooltipLines,
  formatResetAt,
  formatResetIn,
  formatWindowDuration,
  groupAgyQuotaModels,
  resolveActiveAgyQuotaGroupKeys,
  type AgyGroupMemberModel
} from './usage-snapshot-format';
import './UsageSnapshotCell.css';

interface UsageRecordLike {
  configured?: boolean;
  apiKeyMode?: boolean;
  provider?: string;
  accountRef?: string;
  remainingPct?: number | null;
  usageSnapshot?: AccountUsageSnapshot | null;
  usageRefreshing?: boolean;
}

function formatUsagePercent(value: number | null) {
  return value == null ? '-' : `${value.toFixed(1)}%`;
}

// 燃烧粒子（BurningParticles）要在 JS 里按 HSL 抖动色相，只能吃字面 hex；
// 进度条本身用 getUsageBarTokenColor 的语义 token，随深浅主题翻转。
export function getUsageBarColor(value: number | null) {
  if (value == null) return '#d9d9d9';
  if (value > 80) return '#52c41a';
  if (value > 30) return '#faad14';
  return '#ff4d4f';
}

function getUsageBarTokenColor(value: number | null) {
  if (value == null) return 'var(--color-disabled)';
  if (value > 80) return 'var(--color-success)';
  if (value > 30) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

// CodeBuddy 家族四支共用同一份 `codebuddy_credit_balance` 快照（同地区 work/code 是同一个
// 账号、同一份积分），因此这里按 **provider 集合 + kind** 分支，而不是按单个 provider。
const CODEBUDDY_FAMILY_PROVIDERS = ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'];

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

// kimi 条目顺序：月度订阅总量（bucket=monthly）置顶，短窗按时长升序居中，
// 赠送额度（category=gift）垫底。默认展示前 2 条 = 月度 + 最近窗口。
function orderKimiEntries(entries: CodexUsageEntry[]) {
  const rankOf = (entry: CodexUsageEntry) => {
    if (entry.bucket === 'monthly') return 0;
    if (entry.category === 'gift') return 3;
    const windowValue = Number(entry.windowMinutes);
    return Number.isFinite(windowValue) && windowValue > 0 ? 1 : 2;
  };
  return [...entries].sort((a, b) => {
    const aRank = rankOf(a);
    const bRank = rankOf(b);
    if (aRank !== bRank) return aRank - bRank;
    const aWindow = Number(a.windowMinutes) || 0;
    const bWindow = Number(b.windowMinutes) || 0;
    if (aWindow !== bWindow) return aWindow - bWindow;
    return String(a.window || '').localeCompare(String(b.window || ''));
  });
}

function formatKimiEntryLabel(entry: CodexUsageEntry) {
  if (entry.category === 'gift') return entry.bucket || 'Gift';
  return formatWindowDuration(entry.windowMinutes, entry.window) || entry.bucket || 'usage';
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
        color: 'color-mix(in srgb, var(--hos-white) 75%, transparent)',
        cursor: 'pointer',
        fontSize: 11.5,
        fontFamily: 'var(--font-mono, monospace)',
        wordBreak: 'break-all',
        transition: 'color 0.15s ease',
        userSelect: 'all',
        textAlign: 'left'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--hos-white)';
        e.currentTarget.style.textDecoration = 'underline';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'color-mix(in srgb, var(--hos-white) 75%, transparent)';
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
          borderBottom: '1px solid color-mix(in srgb, var(--hos-white) 18%, transparent)',
          fontSize: 11,
          color: 'color-mix(in srgb, var(--hos-white) 65%, transparent)'
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
                color: 'var(--hos-white)',
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
            borderTop: '1px solid color-mix(in srgb, var(--hos-white) 12%, transparent)',
            textAlign: 'center',
            cursor: 'pointer',
            color: 'color-mix(in srgb, var(--hos-white) 85%, transparent)',
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

function UsageUnitsTooltipBody({ content }: { content: { title: string; detail: string } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ whiteSpace: 'nowrap' }}>{content.title}</span>
      {content.detail ? (
        <span style={{ whiteSpace: 'nowrap', opacity: 0.72 }}>{content.detail}</span>
      ) : null}
    </div>
  );
}

function UsageMetaLine({
  label,
  value,
  resetIn,
  resetAtMs,
  running,
  activityRate,
  effectKey,
  progressTooltip
}: {
  label: string;
  value: number | null;
  resetIn?: string;
  resetAtMs?: number;
  running: boolean;
  activityRate: number;
  effectKey: string;
  progressTooltip?: React.ReactNode;
}) {
  const resetInLabel = formatResetIn(resetIn, resetAtMs);
  const resetLabel = formatResetAt(resetAtMs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: 'var(--color-muted-strong)', fontSize: 'clamp(12.5px, 3.2vw, 13.5px)', whiteSpace: 'nowrap' }}>{label}</span>
        {resetInLabel ? (
          <span style={{ textAlign: 'right', minWidth: 0, color: 'var(--color-muted)', fontSize: 'clamp(11.5px, 3vw, 12.5px)', whiteSpace: 'nowrap' }}>
            {resetInLabel}
          </span>
        ) : null}
      </div>
      <UsageProgressBar
        value={value}
        running={running}
        activityRate={activityRate}
        effectKey={effectKey}
        tooltip={progressTooltip}
      />
      {resetLabel ? (
        <div style={{ color: 'var(--color-muted)', fontSize: 'clamp(11.5px, 3vw, 12.5px)', whiteSpace: 'nowrap' }}>
          {resetLabel}
        </div>
      ) : null}
    </div>
  );
}

function UsageProgressBar({
  value,
  running,
  activityRate,
  effectKey,
  tooltip
}: {
  value: number | null;
  running: boolean;
  activityRate: number;
  effectKey: string;
  tooltip?: React.ReactNode;
}) {
  const percent = Math.max(0, Math.min(100, Number(value || 0)));
  const color = getUsageBarColor(value);
  const strokeColor = getUsageBarTokenColor(value);

  const line = (
    <div className="usage-progress-line" data-usage-progress-value={String(percent)}>
      <div className="usage-progress-track" data-burning-active={running ? 'true' : 'false'}>
        <Progress
          percent={percent}
          size="small"
          strokeColor={strokeColor}
          trailColor="var(--color-overlay)"
          showInfo={false}
        />
        {running && value != null ? (
          <BurningParticles
            anchorPct={percent}
            color={color}
            activityRate={activityRate}
            seedKey={effectKey}
          />
        ) : null}
      </div>
      <span className="usage-progress-value">{formatUsagePercent(value)}</span>
    </div>
  );

  if (!tooltip) return line;
  return (
    <Tooltip title={tooltip} placement="top">
      {line}
    </Tooltip>
  );
}

export default function UsageSnapshotCell({
  record,
  hideModels = false,
  running = false,
  activityRate = 0,
  activeModels
}: {
  record: UsageRecordLike;
  hideModels?: boolean;
  running?: boolean;
  activityRate?: number;
  activeModels?: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const effectKeyPrefix = `${String(record.provider || 'provider')}:${String(record.accountRef || 'account')}`;

  if (!record.configured) return <>-</>;
  if (record.apiKeyMode) {
    return (
      <span
        className="usage-empty-state usage-empty-state--api-key"
        title="API Key 账号当前没有可展示的剩余额度，额度由上游服务管理"
      >
        <span className="usage-empty-state-dot" aria-hidden="true" />
        <span>额度由上游管理</span>
      </span>
    );
  }

  const snapshot = record.usageSnapshot;

  if (
    (record.provider === 'codex' && snapshot?.kind === 'codex_oauth_status')
    || (record.provider === 'claude' && snapshot?.kind === 'claude_oauth_usage')
    || (record.provider === 'kimi' && snapshot?.kind === 'kimi_oauth_usage')
  ) {
    const isKimiSnapshot = record.provider === 'kimi' && snapshot?.kind === 'kimi_oauth_usage';
    const entries = (isKimiSnapshot ? orderKimiEntries : orderCodexEntries)(
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
              label={record.provider === 'kimi'
                ? formatKimiEntryLabel(entry)
                : (formatWindowDuration(entry.windowMinutes, entry.window) || entry.bucket || 'usage')}
              value={entry.remainingPct}
              resetIn={entry.resetIn}
              resetAtMs={entry.resetAtMs}
              running={running}
              activityRate={activityRate}
              effectKey={`${effectKeyPrefix}:window:${entry.window || entry.bucket || 'usage'}:${index}`}
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
          <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spin size="small" />
            <span>刷新中</span>
          </div>
        ) : null}
      </div>
    );
  }

  // CodeBuddy 家族：entries[0] 是**账户级聚合**（bucket=credits，权威值，也是
  // record.remainingPct 的来源），其余是 category='detail' 的每包明细
  // （activity / proTrialMon / freeMon …）。两者都渲染——聚合行给总量，明细行给每个额度包
  // 的剩余；hover 展示「总/剩余/已用」（unitType=credits）。
  // 放在通用兜底分支之前，否则就只剩一条账号级进度条，明细永远看不到。
  if (
    snapshot?.kind === 'codebuddy_credit_balance'
    && CODEBUDDY_FAMILY_PROVIDERS.includes(String(record.provider || ''))
  ) {
    const rows = buildCodebuddyCreditRows(snapshot.entries);
    if (rows.length === 0) {
      return record.usageRefreshing ? (
        <Space size={6}>
          <span>-</span>
          <Spin size="small" />
        </Space>
      ) : <>-</>;
    }
    const visibleRows = hideModels ? rows.slice(0, 1) : (expanded ? rows : rows.slice(0, 2));
    return (
      <div style={{ minWidth: 200 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visibleRows.map((row, index) => {
            const rawEntry = row.entry;
            const unitsLines = buildUsageUnitsTooltipLines(rawEntry);
            return (
              <UsageMetaLine
                key={row.key}
                label={row.label}
                value={row.value}
                resetIn={rawEntry.resetIn}
                resetAtMs={rawEntry.resetAtMs}
                running={running}
                activityRate={activityRate}
                effectKey={`${effectKeyPrefix}:bucket:${rawEntry.bucket || 'usage'}:${index}`}
                progressTooltip={unitsLines ? <UsageUnitsTooltipBody content={unitsLines} /> : undefined}
              />
            );
          })}
        </div>
        {!hideModels && rows.length > 2 ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 22, marginTop: 4, fontSize: 13 }}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${rows.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
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
              color: 'var(--color-heading)',
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
            // billing/balance 带 unit_type=token 的绝对额度时，hover 进度条展示「总/剩余/已用」。
            const unitsLines = buildUsageUnitsTooltipLines(entry);
            return (
              <UsageMetaLine
                key={`${entry.bucket}-${entry.window}-${index}`}
                label={label}
                value={entry.remainingPct}
                resetIn={entry.resetIn}
                resetAtMs={entry.resetAtMs}
                running={running}
                activityRate={activityRate}
                effectKey={`${effectKeyPrefix}:bucket:${entry.bucket || 'usage'}:${entry.window || 'window'}:${index}`}
                progressTooltip={unitsLines ? <UsageUnitsTooltipBody content={unitsLines} /> : undefined}
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
          <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
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
    const activeGroupKeys = new Set(
      resolveActiveAgyQuotaGroupKeys(groups, activeModels, running)
    );

    return (
      <div style={{ minWidth: 220 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map((group) => {
            const visibleLimits = hideModels
              ? group.limits.slice(0, 1)
              : group.limits.slice(0, 2);
            const groupRunning = activeGroupKeys.has(group.key);

            return (
              <div
                key={group.key}
                data-usage-quota-group={group.key}
                data-usage-group-active={groupRunning ? 'true' : 'false'}
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Tooltip
                    overlayClassName="token-usage-tooltip-overlay"
                    title={<AgyGroupModelsTooltip members={group.members} />}
                    placement="topLeft"
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontWeight: 600,
                        fontSize: 'clamp(12px, 3vw, 12.5px)',
                        color: 'var(--color-heading)',
                        letterSpacing: '0.15px',
                        cursor: 'help',
                        borderBottom: '1px dotted var(--color-faint)'
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
                      running={groupRunning}
                      activityRate={activityRate}
                      effectKey={`${effectKeyPrefix}:group:${group.key}:${limit.label}:${index}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {record.usageRefreshing ? (
          <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
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
              running={running}
              activityRate={activityRate}
              effectKey={`${effectKeyPrefix}:model:${model.model || 'model'}:${index}`}
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
          <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
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
      <UsageProgressBar
        value={record.remainingPct ?? null}
        running={running}
        activityRate={activityRate}
        effectKey={`${effectKeyPrefix}:remaining`}
      />
      {record.usageRefreshing ? (
        <div style={{ marginTop: 4, color: 'var(--color-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spin size="small" />
          <span>刷新中</span>
        </div>
      ) : null}
    </div>
  );
}
