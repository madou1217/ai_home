import React from 'react';
import { Badge, Space, Tag, Tooltip } from 'antd';
import { CheckCircleOutlined, MobileOutlined } from '@ant-design/icons';
import type { Account } from '@/types';
import {
  formatQuotaReason,
  formatSchedulableReason,
  getAccountDisplayState,
  requiresAccountReauth
} from './account-state.ts';
import { formatAccountIssueReason } from '@/utils/account-reasons';
import { formatRuntimeUntil } from '@/components/runtime/RuntimeStatusTag';
import { getAccountIdentityLabel, getAccountSecondaryIdentity } from '@/utils/account-labels';
import { getRuntimeModelLines } from './runtime-models';

// 账号行展示徽章与角色标签 —— 纯渲染组件模块。
// 从 Accounts.tsx 抽取：运行时状态 / 停池 / 额度 / 综合状态徽章、
// 默认 + App 角色标签与图标、以及计划档位标签。

export function getAccountPrimaryLabel(record: Account) {
  return getAccountIdentityLabel(record);
}

export function getAccountSecondaryLabel(record: Account) {
  return getAccountSecondaryIdentity(record);
}

// zcode 的**服务区域**（zai 国际站 / bigmodel 国内站）。与 kimi 的 region 语义不同
// （那是网络区域 china/overseas），因此读的是独立字段 zcodeRegion。
// 用途：同一用户能在两个区域各有账号、邮箱相同或被上游打码，只有区域能分开。
// 标签文案与 lib/server/zcode-region.js 的区域表同源。
const ZCODE_REGION_META: Record<string, { color: string; label: string }> = {
  zai: { color: 'blue', label: 'Z.AI 国际站' },
  bigmodel: { color: 'orange', label: 'BigModel 国内站' }
};

export function getAccountRegionMeta(record: Pick<Account, 'provider' | 'region' | 'zcodeRegion'>) {
  if (record.provider === 'zcode') {
    const meta = ZCODE_REGION_META[String(record.zcodeRegion || '').trim()];
    // 未判定区域时不渲染标签（不要谎报一个区域）。
    return meta ? { ...meta, endpoint: '' } : null;
  }
  if (record.provider !== 'kimi') return null;
  if (record.region === 'china') {
    return { color: 'blue', label: '中国区', endpoint: 'www.kimi.com' };
  }
  if (record.region === 'overseas') {
    return { color: 'geekblue', label: '海外区', endpoint: 'www.kimi.ai' };
  }
  return { color: 'default', label: '区域未知', endpoint: '' };
}

export type AccountBadgeStatus = 'success' | 'processing' | 'default' | 'error' | 'warning';

export interface AccountBadgeMeta {
  status: AccountBadgeStatus;
  label: string;
}

const RUNTIME_STATUS_META: Record<string, AccountBadgeMeta> = {
  healthy: { status: 'success', label: '正常' },
  billing_blocked: { status: 'error', label: '余额不足 / 账单受限' },
  quota_exhausted: { status: 'warning', label: '额度耗尽' },
  permission_denied: { status: 'error', label: '权限受限' },
  rate_limited: { status: 'warning', label: '限流中' },
  auth_invalid: { status: 'error', label: '认证失效' },
  overloaded: { status: 'warning', label: '上游繁忙' },
  transient_network: { status: 'warning', label: '网络抖动' },
  service_unavailable: { status: 'error', label: '服务不可用' },
  upstream_error: { status: 'error', label: '上游错误' },
  cooling_down: { status: 'default', label: '冷却中' },
  unknown: { status: 'default', label: '未知' }
};

export function getRuntimeStatusMeta(record: Pick<Account, 'runtimeStatus'>): AccountBadgeMeta {
  const status = record.runtimeStatus || 'unknown';
  return RUNTIME_STATUS_META[status] || { status: 'default', label: status };
}

export function renderRuntimeStatusBadge(record: Pick<Account, 'runtimeStatus' | 'runtimeReason' | 'runtimeUntil'>) {
  const reason = record.runtimeReason;
  const until = record.runtimeUntil;

  const meta = getRuntimeStatusMeta(record);
  const normalizedReason = String(reason || '').trim();
  const formattedReason = formatAccountIssueReason(normalizedReason);
  const normalizedUntil = Number(until || 0);

  const badge = <Badge status={meta.status} text={meta.label} />;

  if (!normalizedReason && !normalizedUntil) {
    return badge;
  }

  return (
    <Tooltip
      title={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 360 }}>
          <div>{meta.label}</div>
          {normalizedReason ? <div>错误信息: {formattedReason}</div> : null}
          {normalizedUntil ? <div>恢复时间: {formatRuntimeUntil(normalizedUntil)}</div> : null}
        </div>
      )}
    >
      <span>
        {badge}
      </span>
    </Tooltip>
  );
}

export function getPolicyBlockedMeta(record: Pick<Account, 'schedulableReason'>): AccountBadgeMeta | null {
  const rawReason = String(record.schedulableReason || '').trim();
  if (!rawReason) return null;
  return (
    rawReason === 'codex_free_plan_below_server_min_remaining'
      ? { status: 'warning', label: 'Free 阈值停池' }
      : rawReason === 'codex_free_plan_missing_rate_limits'
        ? { status: 'warning', label: 'Free 待确认' }
        : rawReason === 'codex_team_plan_missing_rate_limits'
          ? { status: 'warning', label: 'Team 待确认' }
          : rawReason === 'agy_access_token_required'
            ? { status: 'warning', label: '需 Token' }
          : { status: 'warning', label: '已停池' }
  );
}

export function renderPolicyBlockedBadge(record: Pick<Account, 'schedulableReason'>) {
  const meta = getPolicyBlockedMeta(record);
  if (!meta) return null;
  const reason = formatSchedulableReason(record.schedulableReason);
  const badge = <Badge status={meta.status} text={meta.label} />;
  if (!reason) return badge;
  return (
    <Tooltip title={reason}>
      <span>
        {badge}
      </span>
    </Tooltip>
  );
}

export function getQuotaStateMeta(record: Pick<Account, 'quotaStatus' | 'quotaReason'>): AccountBadgeMeta | null {
  const status = String(record.quotaStatus || '').trim();
  if (!status || ['available', 'exhausted'].includes(status)) return null;
  const rawReason = String(record.quotaReason || '').trim();
  if (status === 'not_applicable') {
    // 「套餐已领取、额度还没生效」是**另一种结论**：不是没有套餐，也不是采集失败，
    // 而是生效时间还没到（zcode 领完臭鸡蛋的常态）。单独出徽章，别混进「额度不适用」。
    if (/^plan_not_effective_yet/i.test(rawReason)) {
      return { status: 'processing', label: '套餐未生效' };
    }
    // 「额度不适用」是来源给出的**结论**（该账号没有可消耗的额度池：未订阅/已到期/Free 档），
    // 有结论原因才出徽章，让用户明白「为什么看不到额度」；空 reason（API Key 模式、
    // provider 无额度能力）保持静默，避免给每个密钥账号加噪音。
    return rawReason ? { status: 'default', label: '额度不适用' } : null;
  }
  return (
    status === 'probe_failed' ? { status: 'error', label: '采集失败' }
      : status === 'provider_unavailable' && rawReason === 'codex_team_plan_missing_rate_limits'
        ? { status: 'warning', label: 'Team 待确认' }
        : status === 'provider_unavailable' && rawReason === 'codex_free_plan_missing_rate_limits'
          ? { status: 'warning', label: 'Free 待确认' }
        : status === 'provider_unavailable' ? { status: 'warning', label: '上游未返回' }
        : status === 'pending' && rawReason === 'provider_returned_no_numeric_usage'
          ? { status: 'default', label: '额度未知' }
        : status === 'pending' ? { status: 'processing', label: '等待采集' }
          : { status: 'default', label: '额度未知' }
  );
}

export function renderQuotaStateBadge(record: Pick<Account, 'quotaStatus' | 'quotaReason'>) {
  const meta = getQuotaStateMeta(record);
  if (!meta) return null;
  const reason = formatQuotaReason(record.quotaReason);
  const badge = <Badge status={meta.status} text={meta.label} />;
  if (!reason) return badge;
  return (
    <Tooltip title={reason}>
      <span>
        {badge}
      </span>
    </Tooltip>
  );
}

/**
 * 账号综合状态徽章的纯数据版（与 renderAccountDisplayBadge 同一分支顺序与文案）。
 * 移动端用它渲染 LED + 短文字，桌面继续用带 Tooltip 的 renderAccountDisplayBadge。
 */
export function getAccountDisplayBadgeMeta(record: Account): AccountBadgeMeta {
  if (!record.configured && record.authPendingStale) return { status: 'warning', label: '授权超时' };
  if (requiresAccountReauth(record)) return { status: 'error', label: '需要重新登录' };
  const state = getAccountDisplayState(record);
  if (state === 'disabled') return { status: 'default', label: '已关闭' };
  if (state === 'unconfigured') return { status: 'default', label: '未配置' };
  if (state === 'runtime_blocked') return getRuntimeStatusMeta(record);
  if (state === 'policy_blocked') return getPolicyBlockedMeta(record) || { status: 'warning', label: '已停池' };
  if (state === 'exhausted') return { status: 'error', label: '已耗尽' };
  if (getRuntimeModelLines(record).length > 0) return { status: 'warning', label: '部分模型受限' };
  if (record.apiKeyMode) return { status: 'success', label: '可调度' };
  return { status: 'success', label: '正常' };
}

/**
 * 综合状态的补充说明（桌面在徽章 Tooltip 里展示的同一批原因文本），按行返回。
 * 只读取调度相关的真实字段：运行时原因 / 恢复时间、停池原因；额度采集单独展示。
 */
export function getAccountStatusDetailLines(record: Account): string[] {
  const lines: string[] = [];
  const state = getAccountDisplayState(record);
  if (state === 'runtime_blocked') {
    const reason = String(record.runtimeReason || '').trim();
    const until = Number(record.runtimeUntil || 0);
    if (reason) lines.push(`错误信息: ${formatAccountIssueReason(reason)}`);
    if (until) lines.push(`恢复时间: ${formatRuntimeUntil(until)}`);
  } else if (state === 'policy_blocked') {
    const reason = formatSchedulableReason(record.schedulableReason);
    if (reason) lines.push(reason);
  } else if (state === 'healthy' && getRuntimeModelLines(record).length > 0) {
    lines.push(...getRuntimeModelLines(record));
  } else if (state === 'healthy' && record.apiKeyMode) {
    lines.push('密钥已配置且当前没有运行时阻塞；网络和模型接口可达性请看模型探测。');
  }
  return lines;
}

export function renderAccountDisplayBadge(record: Account) {
  if (!record.configured && record.authPendingStale) return <Badge status="warning" text="授权超时" />;
  if (requiresAccountReauth(record)) return <Badge status="error" text="需要重新登录" />;
  const state = getAccountDisplayState(record);
  if (state === 'disabled') return <Badge status="default" text="已关闭" />;
  if (state === 'unconfigured') return <Badge status="default" text="未配置" />;
  if (state === 'runtime_blocked') {
    return renderRuntimeStatusBadge(record);
  }
  if (state === 'policy_blocked') {
    return renderPolicyBlockedBadge(record) || <Badge status="warning" text="已停池" />;
  }
  if (state === 'exhausted') {
    return (
      <Badge
        status="error"
        text="已耗尽"
      />
    );
  }
  const runtimeModelLines = getRuntimeModelLines(record);
  if (runtimeModelLines.length > 0) {
    return (
      <Tooltip
        title={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 360 }}>
            <div>账号仍可调度，以下模型暂时跳过：</div>
            {runtimeModelLines.map((line) => <div key={line}>{line}</div>)}
          </div>
        )}
      >
        <span>
          <Badge status="warning" text="部分模型受限" />
        </span>
      </Tooltip>
    );
  }
  if (record.apiKeyMode) {
    return (
      <Tooltip title="密钥已配置且当前没有运行时阻塞；网络和模型接口可达性请看模型探测。">
        <span>
          <Badge
            status="success"
            text="可调度"
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <Badge
      status="success"
      text="正常"
    />
  );
}

const accountRoleTagStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 4px',
  display: 'inline-flex',
  alignItems: 'center',
  marginInlineEnd: 0
};

export function renderAccountRegionTag(record: Pick<Account, 'provider' | 'region' | 'zcodeRegion'>) {
  const meta = getAccountRegionMeta(record);
  if (!meta) return null;
  const detail = record.provider === 'zcode'
    ? `ZCode 服务区域：${meta.label}（凭据里的 oauth:active_provider）`
    : (meta.endpoint
      ? `Kimi Desktop 当前生效区域：${meta.label}（${meta.endpoint}）`
      : '尚未从该账号的 Kimi Desktop profile 读取到有效区域。');
  return (
    <Tooltip title={detail}>
      <Tag color={meta.color} style={accountRoleTagStyle}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

// HUD 方形读数徽标：2px 圆角 + 同色发丝框（圆形只留给 LED / 头像 / 计数，web/DESIGN.md §4）。
const accountRoleIconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 2,
  border: '1px solid color-mix(in srgb, currentColor 40%, transparent)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  flex: '0 0 auto'
};

export function renderAccountRoleTags(record: Pick<Account, 'isDefault' | 'isMobile'>) {
  if (!record.isDefault && !record.isMobile) return null;
  return (
    <>
      {record.isDefault ? (
        <Tooltip title="默认账号">
          <Tag color="blue" icon={<CheckCircleOutlined />} style={accountRoleTagStyle}>
            默认
          </Tag>
        </Tooltip>
      ) : null}
      {record.isMobile ? (
        <Tooltip title="Codex App 账号">
          <Tag color="purple" icon={<MobileOutlined />} style={accountRoleTagStyle}>
            App
          </Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

export function renderAccountRoleIcons(record: Pick<Account, 'isDefault' | 'isMobile'>) {
  if (!record.isDefault && !record.isMobile) return null;
  return (
    <Space size={4} style={{ flex: '0 0 auto' }}>
      {record.isDefault ? (
        <Tooltip title="当前默认账号">
          <span style={{ ...accountRoleIconStyle, color: 'var(--color-info)', background: 'var(--color-info-soft)' }}>
            <CheckCircleOutlined />
          </span>
        </Tooltip>
      ) : null}
      {record.isMobile ? (
        <Tooltip title="当前 Codex App 账号">
          <span style={{ ...accountRoleIconStyle, color: 'var(--event-thinking)', background: 'var(--event-thinking-soft)' }}>
            <MobileOutlined />
          </span>
        </Tooltip>
      ) : null}
    </Space>
  );
}

/**
 * 单个套餐标签（多套餐场景请用 getPlanTagLabels）。
 *
 * **不再回退到拼接的 planType**：zcode 叠加套餐时后端把展示名拼成
 * `A + B` 塞进 planType，直接返回它会让调用方（移动端行/详情页）显示那串
 * `+` 拼接——用户明确要求拆开。这里改为返回**第一个**套餐名，
 * 需要全部时用 getPlanTagLabels()。
 */
export function getPlanTagLabel(record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName' | 'usageSnapshot'>) {
  return getPlanTagLabels(record)[0] || 'free';
}

/**
 * 套餐标签**拆分成多个**。
 *
 * 为什么不能只给一个标签：zcode 同账号可能叠加多个套餐（「领臭鸡蛋」），后端把展示名
 * 拼成 `A + B` 塞进 planType。整串当一个标签会有两个问题——**宽度随套餐增减而变**，
 * 且 `+` 拼接在窄列里被截断（真机：「ZCODE GLOBAL BUILD + ZCode Start Plan」显示成
 * 半截）。拆开渲染后每个标签宽度稳定，行内自动换行。
 *
 * 数据来源优先级：
 *   1. 额度快照的 planGroups（**结构化**，每个套餐一个 name，最可靠）；
 *   2. planName（其它 provider 的订阅档，单值）；
 *   3. 把 planType 按分隔符拆开（兜底，兼容没有 planGroups 的快照）。
 */
export function getPlanTagLabels(
  record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName' | 'usageSnapshot'>
): string[] {
  if (record.apiKeyMode) return ['密钥'];
  // 1. 结构化套餐分组。
  const snapshot = record.usageSnapshot;
  // 0. 服务端**已经拆好的**套餐名列表（最直接，不依赖 planGroups 是否随 payload 下发）。
  const rawPlanNames = snapshot && typeof snapshot === 'object' && 'account' in snapshot
    ? (snapshot.account as { planNames?: unknown } | null | undefined)?.planNames
    : undefined;
  const accountPlanNames = Array.isArray(rawPlanNames)
    ? rawPlanNames.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (accountPlanNames.length > 0) return Array.from(new Set(accountPlanNames));
  const groups = snapshot && typeof snapshot === 'object' && 'planGroups' in snapshot
    && Array.isArray(snapshot.planGroups) ? snapshot.planGroups : [];
  const groupNames = groups
    .map((g) => String((g && g.name) || '').trim())
    .filter(Boolean);
  if (groupNames.length > 0) return Array.from(new Set(groupNames));
  // 2. 订阅档（kimi 等）优先于枚举值。
  const planName = String(record.planName || '').trim();
  if (planName) return [planName];
  // 3. 兜底拆分：` + ` 是后端拼多套餐用的分隔符（见 zcode-quota-probe 的 planType 汇总）。
  const planType = String(record.planType || '').trim();
  if (!planType) return ['free'];
  const parts = planType.split(/\s*\+\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [planType];
}

export function getPlanTagColor(record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName'>) {
  if (record.apiKeyMode) return 'cyan';
  // kimi 订阅档位（按速度术语递增）：Andante < Moderato < Allegretto < Allegro
  const planName = String(record.planName || '').toLowerCase();
  if (planName === 'andante') return 'default';
  if (planName === 'moderato') return 'green';
  if (planName === 'allegretto') return 'geekblue';
  if (planName === 'allegro') return 'gold';
  if (record.planType === 'free') return 'default';
  if (record.planType === 'pro') return 'green';
  if (record.planType === 'ultra') return 'purple';
  if (record.planType === 'team') return 'blue';
  if (record.planType === 'plus') return 'green';
  if (record.planType === 'business') return 'gold';
  return 'default';
}

// kimi 桌面端托管 session 读取到的订阅套餐信息（挂在用量快照 account 上）。
export function getKimiPlanSubscription(record: Pick<Account, 'provider' | 'usageSnapshot'>) {
  if (record.provider !== 'kimi') return null;
  const snapshot = record.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'kimi_oauth_usage' || !snapshot.account) return null;
  const subscription = snapshot.account.planSubscription;
  if (!subscription || (!subscription.name && !(subscription.validUntilMs > 0))) return null;
  return subscription;
}

// Cline Pass 的订阅周期（额度插件把 planName 与 currentPeriodEnd 写进快照 account）。
export function getClinePlanSubscription(record: Pick<Account, 'provider' | 'usageSnapshot'>) {
  if (record.provider !== 'cline') return null;
  const snapshot = record.usageSnapshot;
  if (!snapshot || snapshot.kind !== 'cline_pass_usage' || !snapshot.account) return null;
  const validUntilMs = Number(snapshot.account.periodEndMs) || 0;
  const name = String(snapshot.account.planName || '').trim();
  if (!name && validUntilMs <= 0) return null;
  return { name, validUntilMs, status: '' };
}

export function formatPlanValidUntil(validUntilMs: number | null | undefined) {
  const value = Number(validUntilMs);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
