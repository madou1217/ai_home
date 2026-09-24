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

function getUsageBarTokenName(value: number | null) {
  if (value == null) return '--color-disabled';
  if (value > 80) return '--color-success';
  if (value > 30) return '--color-warning';
  return '--color-danger';
}

function getUsageBarTokenColor(value: number | null) {
  return `var(${getUsageBarTokenName(value)})`;
}

// 状态语义（与进度条颜色同一阈值）：用于百分比读数的着色 / 辉光类名。
export function getUsageBarTone(value: number | null) {
  if (value == null) return 'none';
  if (value > 80) return 'ok';
  if (value > 30) return 'warn';
  return 'danger';
}

// 燃烧粒子（BurningParticles）要在 JS 里按 HSL 抖动色相，需要具体的 #rrggbb。
// 这里在运行时读取当前主题（深色 HUD / 日光 HUD）的语义状态色，不写死字面色值；
// 读不到（SSR / 非 hex token）时返回空串，粒子模型回落到它自己的默认火焰色。
export function getUsageBarColor(value: number | null) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  try {
    const resolved = window.getComputedStyle(document.documentElement)
      .getPropertyValue(getUsageBarTokenName(value))
      .trim();
    return /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : '';
  } catch (_error) {
    return '';
  }
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
      className="usage-model-id-copy"
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
    <div className="usage-group-models">
      <div className="usage-group-models-row usage-group-models-head">
        <span>名称 ({members.length})</span>
        <span>模型 ID</span>
      </div>
      <div
        className="usage-group-models-list"
        style={{ maxHeight: showAll ? 280 : 190 }}
      >
        {visibleMembers.map((m) => (
          <div key={m.id} className="usage-group-models-row">
            <span className="usage-group-models-name">{m.name}</span>
            <div className="usage-group-models-id">
              <CopyableModelId modelId={m.id} />
            </div>
          </div>
        ))}
      </div>
      {isLargeList ? (
        <div
          className="usage-group-models-toggle"
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
    <div className="usage-units-tooltip">
      <span>{content.title}</span>
      {content.detail ? (
        <span className="usage-units-tooltip-detail">{content.detail}</span>
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
    <div className="usage-meta-line">
      <div className="usage-meta-line-head">
        <span className="usage-meta-line-label">{label}</span>
        {resetInLabel ? (
          <span className="usage-meta-line-reset-in">
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
        <div className="usage-meta-line-reset-at">
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
            color={getUsageBarColor(value)}
            activityRate={activityRate}
            seedKey={effectKey}
          />
        ) : null}
      </div>
      <span className={`usage-progress-value usage-progress-value--${getUsageBarTone(value)}`}>{formatUsagePercent(value)}</span>
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
        <div className="usage-meta-list">
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
            className="usage-expand-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${entries.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div className="usage-refreshing">
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
        <div className="usage-meta-list">
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
            className="usage-expand-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${rows.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div className="usage-refreshing">
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
          <div className="usage-group-title usage-group-title--plan">
            {planName}
          </div>
        ) : null}
        <div className="usage-meta-list">
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
            className="usage-expand-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${entries.length - 2} 项`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div className="usage-refreshing">
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
        <div className="usage-meta-list usage-meta-list--groups">
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
                className="usage-quota-group"
              >
                <div className="usage-quota-group-head">
                  <Tooltip
                    overlayClassName="token-usage-tooltip-overlay"
                    title={<AgyGroupModelsTooltip members={group.members} />}
                    placement="topLeft"
                  >
                    <span className="usage-group-title usage-group-title--help">
                      {group.title}
                    </span>
                  </Tooltip>
                </div>

                <div className="usage-meta-list">
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
          <div className="usage-refreshing">
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
        <div className="usage-meta-list">
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
            className="usage-expand-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${models.length - 2} 个模型`}
          </Button>
        ) : null}
        {record.usageRefreshing ? (
          <div className="usage-refreshing">
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
        <div className="usage-refreshing">
          <Spin size="small" />
          <span>刷新中</span>
        </div>
      ) : null}
    </div>
  );
}
