import { useState } from 'react';
import { message, Progress, Space, Spin, Tooltip } from 'antd';
import type { AccountUsageSnapshot } from '@/types';
import Button from '@/components/ui/AppButton';
import BurningParticles from '@/features/accounts/BurningParticles';
import { getQuotaStateMeta, renderQuotaStateBadge } from '@/features/accounts/AccountBadges';
import {
  buildUsageUnitsTooltipLines,
  formatResetAt,
  formatResetIn,
  groupAgyQuotaModels,
  resolveActiveAgyQuotaGroupKeys,
  type AgyGroupMemberModel
} from './usage-snapshot-format';
import {
  getPrimaryQuotaScopes,
  hasRenderableScopes,
  isNamedBucket
} from './quota-scopes';
import './UsageSnapshotCell.css';

interface UsageRecordLike {
  configured?: boolean;
  apiKeyMode?: boolean;
  provider?: string;
  accountRef?: string;
  remainingPct?: number | null;
  usageSnapshot?: AccountUsageSnapshot | null;
  usageRefreshing?: boolean;
  quotaStatus?: string;
  quotaReason?: string;
}

interface UsageSnapshotCellProps {
  record: UsageRecordLike;
  hideModels?: boolean;
  running?: boolean;
  activityRate?: number;
  activeModels?: string[];
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
  progressTooltip,
  unknownLabel
}: {
  label: string;
  value: number | null;
  resetIn?: string;
  resetAtMs?: number;
  running: boolean;
  activityRate: number;
  effectKey: string;
  progressTooltip?: React.ReactNode;
  unknownLabel?: string;
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
      {value == null ? <span className="usage-empty-state">{unknownLabel || '额度未知'}</span> : <UsageProgressBar
        value={value}
        running={running}
        activityRate={activityRate}
        effectKey={effectKey}
        tooltip={progressTooltip}
      />}
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

type UsageSnapshotKind = AccountUsageSnapshot['kind'];
type SnapshotOf<K extends UsageSnapshotKind> = Extract<AccountUsageSnapshot, { kind: K }>;

interface UsageRendererProps {
  record: UsageRecordLike;
  snapshot: AccountUsageSnapshot;
  hideModels: boolean;
  running: boolean;
  activityRate: number;
  activeModels?: string[];
  effectKeyPrefix: string;
}

// **统一的额度渲染器**：行来自服务端归一好的 scope（label / 顺序 / 旁路标记 / 单位），
// 因此窗口（codex/claude/cline/kimi）、余额桶（kiro/codebuddy/workbuddy/grok）、
// 每模型余额桶（zcode）走的是同一条路径 —— 新增 provider 不需要在这里加分支。
//
// 只有 agy 的「按模型分组 + 每组限额」是真正特殊的展示，仍单独注册（见渲染器表）。
function ScopesUsage({ record, snapshot, hideModels, running, activityRate, effectKeyPrefix }: UsageRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const rows = getPrimaryQuotaScopes(snapshot);
  if (rows.length === 0) {
    return record.usageRefreshing ? (
      <Space size={6}>
        <span>-</span>
        <Spin size="small" />
      </Space>
    ) : <>-</>;
  }
  const visibleRows = hideModels ? rows.slice(0, 1) : (expanded ? rows : rows.slice(0, 2));
  // 具名桶（zcode 的每模型余额）在组标题位置显示套餐名，通用桶不显示。
  const planName = rows.some((row) => isNamedBucket(row.bucket))
    ? String(('account' in snapshot ? snapshot.account?.planType : '') || '')
    : '';
  return (
    <div style={{ minWidth: 200 }}>
      {planName ? (
        <div className="usage-group-title usage-group-title--plan">{planName}</div>
      ) : null}
      <div className="usage-meta-list">
        {visibleRows.map((row, index) => {
          const unitsLines = buildUsageUnitsTooltipLines(row);
          return (
            <UsageMetaLine
              key={row.key}
              label={row.label}
              value={row.remainingPct}
              resetIn={row.resetIn}
              resetAtMs={row.resetAtMs}
              running={running}
              activityRate={activityRate}
              effectKey={`${effectKeyPrefix}:scope:${row.shape}:${row.bucket || row.model || 'usage'}:${index}`}
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

function AgyQuotaUsage({ record, snapshot: rawSnapshot, hideModels, running, activityRate, activeModels, effectKeyPrefix }: UsageRendererProps) {
  // 渲染器表按 kind 派发，这里的快照必然是该 kind。
  const snapshot = rawSnapshot as SnapshotOf<'agy_code_assist_quota'>;
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

// 派发规则：**先按服务端下发的条目形态走通用渲染器**，只有 agy 的「按模型分组 + 每组限额」
// 是真正特殊的展示，按 kind 单独注册。新增 provider 不需要在这里加分支。
const USAGE_SNAPSHOT_RENDERERS: Partial<Record<UsageSnapshotKind, (props: UsageRendererProps) => JSX.Element>> = {
  agy_code_assist_quota: AgyQuotaUsage
};

function UsageSnapshotBody({
  record,
  hideModels = false,
  running = false,
  activityRate = 0,
  activeModels
}: UsageSnapshotCellProps) {
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

  const Renderer = snapshot ? USAGE_SNAPSHOT_RENDERERS[snapshot.kind] : undefined;
  if (snapshot && Renderer) {
    return (
      <Renderer
        record={record}
        snapshot={snapshot}
        hideModels={hideModels}
        running={running}
        activityRate={activityRate}
        activeModels={activeModels}
        effectKeyPrefix={effectKeyPrefix}
      />
    );
  }

  // 任何声明了条目形态的快照（window / bucket / models）都能由通用渲染器列出全部额度行；
  // 只有真的没有可渲染条目时才回落到单条账号级进度条。
  if (snapshot && hasRenderableScopes(snapshot)) {
    return (
      <ScopesUsage
        record={record}
        snapshot={snapshot}
        hideModels={hideModels}
        running={running}
        activityRate={activityRate}
        activeModels={activeModels}
        effectKeyPrefix={effectKeyPrefix}
      />
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

export default function UsageSnapshotCell(props: UsageSnapshotCellProps) {
  const { record } = props;
  const hasCollectionNotice = record.configured && !record.apiKeyMode && getQuotaStateMeta(record);
  if (!hasCollectionNotice) return <UsageSnapshotBody {...props} />;
  return (
    <div className="usage-meta-list" data-quota-status={record.quotaStatus}>
      {renderQuotaStateBadge(record)}
      {record.usageSnapshot || record.remainingPct != null || record.usageRefreshing
        ? <UsageSnapshotBody {...props} /> : null}
    </div>
  );
}
