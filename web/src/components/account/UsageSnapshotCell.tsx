import { useState } from 'react';
import { message, Progress, Space, Spin, Tooltip } from 'antd';
import type { AccountUsageSnapshot } from '@/types';
import Button from '@/components/ui/AppButton';
import BurningParticles from '@/features/accounts/BurningParticles';
import { getQuotaStateMeta, renderQuotaStateBadge } from '@/features/accounts/AccountBadges';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildUsageUnitsTooltipLines,
  formatResetAt,
  formatResetIn,
  groupAgyQuotaModels,
  resolveActiveAgyQuotaGroupKeys,
  type AgyGroupMemberModel
} from './usage-snapshot-format';
import {
  getQuotaScopes,
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
      await writeClipboardText(modelId);
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

function formatSnapshotAge(capturedAt?: number | null): string {
  const value = Number(capturedAt);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 额度来源/年龄：紧凑行内信息，过期时才改变颜色，不使用整块提示。 */
function UsageProvenance({ provenance }: { provenance: NonNullable<AccountUsageSnapshot['provenance']> }) {
  const sourceId = String(provenance.id || '').trim();
  const age = formatSnapshotAge(provenance.capturedAt);
  if (!sourceId && !age && !provenance.stale) return null;
  const title = [
    sourceId ? `来源 ${sourceId}` : '',
    provenance.kind ? `类型 ${provenance.kind}` : '',
    age ? `快照 ${age}` : '',
    provenance.stale ? '数据可能已过期' : ''
  ].filter(Boolean).join(' · ');
  return (
    <span
      className={`usage-provenance${provenance.stale ? ' usage-provenance--stale' : ''}`}
      title={title}
    >
      {sourceId || '来源未知'}
      {age ? ` · ${age}` : ''}
      {provenance.stale ? ' · 已过期' : ''}
    </span>
  );
}

function UsageMetaLine({
  label,
  tag,
  value,
  resetIn,
  resetAtMs,
  running,
  activityRate,
  effectKey,
  progressTooltip,
  unknownLabel,
  enterClass
}: {
  label: string;
  tag?: string;
  value: number | null;
  resetIn?: string;
  resetAtMs?: number;
  running: boolean;
  activityRate: number;
  effectKey: string;
  progressTooltip?: React.ReactNode;
  unknownLabel?: string;
  /** 「展开更多」时才挂载的行带进场类，避免首屏一批卡片同时逐行淡入。 */
  enterClass?: string;
}) {
  const resetInLabel = formatResetIn(resetIn, resetAtMs);
  const resetLabel = formatResetAt(resetAtMs);

  return (
    <div className={`usage-meta-line${enterClass ? ` ${enterClass}` : ''}`}>
      <div className="usage-meta-line-head">
        <span className="usage-meta-line-label">{label}</span>
        {tag ? <span className="usage-meta-line-tag">{tag}</span> : null}
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
// 套餐分组渲染：zcode 的「领臭鸡蛋」叠加新套餐后，同一账号有多个独立额度池。
// 每组一个标题（套餐名）+ 组内额度行，模型同名也不会互相混淆。
// 组内条目走与扁平路径**同一个** scope 投影与行组件，因此标签/单位/旁路标记的口径一致。
/**
 * 快照里有「已领取但还没有额度桶」的套餐组（zcode 领完臭鸡蛋、生效时间未到）。
 * 这类快照的 entries 是空的，但它**有内容可展示**：套餐名 + 生效时间。
 */
function hasPendingPlanGroups(snapshot: AccountUsageSnapshot | null | undefined): boolean {
  if (!snapshot || !('planGroups' in snapshot)) return false;
  const groups = snapshot.planGroups;
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => !Array.isArray(group?.entries) || group.entries.length === 0);
}

function readPendingEffectiveAtMs(snapshot: AccountUsageSnapshot | null | undefined): number {
  if (!snapshot || !('pendingEffectiveAtMs' in snapshot)) return 0;
  return Number(snapshot.pendingEffectiveAtMs) || 0;
}

function PlanGroupedUsage({ groups, hideModels, running, activityRate, effectKeyPrefix, pendingEffectiveAtMs }: {
  groups: NonNullable<Extract<AccountUsageSnapshot, { kind: 'zcode_plan_balance' }>['planGroups']>;
  hideModels: boolean;
  running: boolean;
  activityRate: number;
  effectKeyPrefix: string;
  pendingEffectiveAtMs?: number;
}) {
  // 每个套餐组各自记住是否展开（默认收起，只显示 1 条）。
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div className="usage-snapshot-content usage-snapshot-content--scopes">
      <div className="usage-meta-list usage-meta-list--groups">
        {groups.map((group, groupIndex) => {
          const groupKey = group.planGroupId || group.planId || `group-${groupIndex}`;
          const rows = getQuotaScopes({
            kind: 'zcode_plan_balance',
            capturedAt: 0,
            entries: group.entries
          });
          // 每组默认只显示 **1 条**用量，多余的收进「展开 N 项」——与扁平路径同规矩，
          // 避免一个账号的多个套餐把账号行撑得很高（真机：2 个套餐 × 各 2 个模型
          // = 4 行，横向也挤）。展开状态按组独立记，展开一个组不影响别的组。
          const visibleRows = hideModels ? rows.slice(0, 1) : (expandedGroups.has(groupKey) ? rows : rows.slice(0, 1));
          const label = group.name || group.planId || group.planGroupId;
          // 0 条额度行 = 套餐已领取但还没生效（上游 balances 为空）。
          // 不能像以前那样 return null —— 那样界面上只剩「额度不适用」，
          // 用户看不到自己已经领到的那只臭鸡蛋。
          if (rows.length === 0) {
            const effectiveAtMs = Number(group.effectiveAtMs) || Number(pendingEffectiveAtMs) || 0;
            const effectiveLabel = formatResetAt(effectiveAtMs);
            const hint = effectiveLabel
              ? `套餐已领取，${effectiveLabel} 起生效`
              : '套餐已领取，等待上游生效';
            return (
              <div key={groupKey} className="usage-plan-group">
                <div className="usage-group-title usage-group-title--plan" title={label}>
                  <span className="usage-group-title-text">{label}</span>
                </div>
                <span className="usage-plan-pending" title={hint}>
                  <span className="usage-empty-state-dot" aria-hidden="true" />
                  <span>{effectiveLabel ? `未生效 · ${effectiveLabel} 起可用` : '未生效 · 等待上游生效'}</span>
                </span>
              </div>
            );
          }
          return (
            <div key={groupKey} className="usage-plan-group">
              <div className="usage-group-title usage-group-title--plan" title={label}>
                <span className="usage-group-title-text">{label}</span>
              </div>
              <div className="usage-meta-list">
                {visibleRows.map((row, index) => {
                  const unitsLines = buildUsageUnitsTooltipLines(row);
                  return (
                    <UsageMetaLine
                      key={`${groupIndex}:${row.key}`}
                      label={row.label}
                      tag={row.category === 'gift' ? '赠送' : (row.category === 'detail' ? '明细' : undefined)}
                      value={row.remainingPct}
                      resetIn={row.resetIn}
                      resetAtMs={row.resetAtMs}
                      running={running}
                      activityRate={activityRate}
                      effectKey={`${effectKeyPrefix}:plan:${group.planGroupId || groupIndex}:${row.bucket || row.model || 'usage'}:${index}`}
                      progressTooltip={unitsLines ? <UsageUnitsTooltipBody content={unitsLines} /> : undefined}
                      enterClass={expandedGroups.has(groupKey) ? 'aih-fade-in' : undefined}
                    />
                  );
                })}
              </div>
              {!hideModels && rows.length > 1 ? (
                <Button
                  type="link"
                  size="small"
                  className="usage-expand-toggle"
                  onClick={() => toggleGroup(groupKey)}
                >
                  {expandedGroups.has(groupKey) ? '收起' : `展开 ${rows.length - 1} 项`}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScopesUsage({ record, snapshot, hideModels, running, activityRate, effectKeyPrefix }: UsageRendererProps) {
  const [expanded, setExpanded] = useState(false);
  // 套餐分组（zcode 的「领臭鸡蛋」是**叠加**一个新套餐，同一账号可能同时有多个，
  // 各有独立额度池）。有分组就按套餐分开渲染 —— 扁平 entries 会把两个套餐的同一模型
  // 混成重复行，标题也只能退化成套餐名的拼接串。
  const planGroups = 'planGroups' in snapshot && Array.isArray(snapshot.planGroups)
    ? snapshot.planGroups
    : [];
  // 多套餐，或者「有套餐但一条额度都没有」（已领取、未生效）都走分组渲染：
  // 后者用扁平路径只会得到一行 "-"，套餐名与生效时间全丢。
  if (planGroups.length > 1 || (planGroups.length > 0 && !hasRenderableScopes(snapshot))) {
    return (
      <PlanGroupedUsage
        groups={planGroups}
        hideModels={hideModels}
        running={running}
        activityRate={activityRate}
        effectKeyPrefix={effectKeyPrefix}
        pendingEffectiveAtMs={readPendingEffectiveAtMs(snapshot)}
      />
    );
  }
  // 全部 scope（含 gift/detail）：聚合行 + 每包明细都要看得见；账号级 min 另在
  // account-state 里只吃主额度，两者不冲突。
  const rows = getQuotaScopes(snapshot);
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
    <div className="usage-snapshot-content usage-snapshot-content--scopes">
      {planName ? (
        <div className="usage-group-title usage-group-title--plan" title={planName}>
          <span className="usage-group-title-text">{planName}</span>
        </div>
      ) : null}
      <div className="usage-meta-list">
        {visibleRows.map((row, index) => {
          const unitsLines = buildUsageUnitsTooltipLines(row);
          return (
            <UsageMetaLine
              key={row.key}
              label={row.label}
              tag={row.category === 'gift' ? '赠送' : (row.category === 'detail' ? '明细' : undefined)}
              value={row.remainingPct}
              resetIn={row.resetIn}
              resetAtMs={row.resetAtMs}
              running={running}
              activityRate={activityRate}
              effectKey={`${effectKeyPrefix}:scope:${row.shape}:${row.bucket || row.model || 'usage'}:${index}`}
              progressTooltip={unitsLines ? <UsageUnitsTooltipBody content={unitsLines} /> : undefined}
              enterClass={expanded ? 'aih-fade-in' : undefined}
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
    <div className="usage-snapshot-content usage-snapshot-content--agy">
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
  // 「已领取、未生效」的快照条目为空但套餐结构在，同样要渲染（否则只剩一个 "-"）；
  // 只有真的什么都没有时才回落到单条账号级进度条。
  if (snapshot && (hasRenderableScopes(snapshot) || hasPendingPlanGroups(snapshot))) {
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
  // 老缓存 / 原生 handler 的快照没有 `provenance`，但仍有 `source` 与 `capturedAt`；
  // 用它们做同形状兜底（stale 未知时不冒充过期），新快照仍以宿主归一结果为准。
  const snapshot = record.usageSnapshot as (AccountUsageSnapshot & { source?: string }) | null | undefined;
  const provenance = snapshot?.provenance || (snapshot?.source
    ? { id: snapshot.source, kind: 'provider', capturedAt: snapshot.capturedAt, stale: undefined }
    : null);
  const provenanceLine = provenance ? <UsageProvenance provenance={provenance} /> : null;
  const hasCollectionNotice = record.configured && !record.apiKeyMode && getQuotaStateMeta(record);
  if (!hasCollectionNotice) {
    return (
      <>
        <UsageSnapshotBody {...props} />
        {provenanceLine}
      </>
    );
  }
  // 「额度不适用」是结论态：没有额度行可渲染，徽章即完整信息（不再补一个无意义的 "-"）。
  // 例外是「已领取、未生效」的套餐 —— 那是可展示的事实（套餐名 + 生效时间），
  // 必须把 body 渲染出来，否则用户只看到「套餐未生效」却看不到是哪个套餐。
  const showBody = (record.quotaStatus !== 'not_applicable' || hasPendingPlanGroups(record.usageSnapshot))
    && Boolean(record.usageSnapshot || record.remainingPct != null || record.usageRefreshing);
  return (
    <div className="usage-meta-list" data-quota-status={record.quotaStatus}>
      {renderQuotaStateBadge(record)}
      {showBody ? <UsageSnapshotBody {...props} /> : null}
      {provenanceLine}
    </div>
  );
}
