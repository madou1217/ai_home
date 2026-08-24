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

// 账号行展示徽章与角色标签 —— 纯渲染组件模块。
// 从 Accounts.tsx 抽取：运行时状态 / 停池 / 额度 / 综合状态徽章、
// 默认 + App 角色标签与图标、以及计划档位标签。

export function getAccountPrimaryLabel(record: Account) {
  return getAccountIdentityLabel(record);
}

export function getAccountSecondaryLabel(record: Account) {
  return getAccountSecondaryIdentity(record);
}

export function getAccountRegionMeta(record: Pick<Account, 'provider' | 'region'>) {
  if (record.provider !== 'kimi') return null;
  if (record.region === 'china') {
    return { color: 'blue', label: '中国区', endpoint: 'www.kimi.com' };
  }
  if (record.region === 'overseas') {
    return { color: 'geekblue', label: '海外区', endpoint: 'www.kimi.ai' };
  }
  return { color: 'default', label: '区域未知', endpoint: '' };
}

export function renderRuntimeStatusBadge(record: Pick<Account, 'runtimeStatus' | 'runtimeReason' | 'runtimeUntil'>) {
  const status = record.runtimeStatus || 'unknown';
  const reason = record.runtimeReason;
  const until = record.runtimeUntil;

  const statusMap: Record<string, { status: 'success' | 'processing' | 'default' | 'error' | 'warning'; label: string }> = {
    healthy: { status: 'success', label: '正常' },
    rate_limited: { status: 'warning', label: '限流中' },
    auth_invalid: { status: 'error', label: '认证失效' },
    overloaded: { status: 'warning', label: '上游繁忙' },
    transient_network: { status: 'warning', label: '网络抖动' },
    service_unavailable: { status: 'error', label: '服务不可用' },
    upstream_error: { status: 'error', label: '上游错误' },
    cooling_down: { status: 'default', label: '冷却中' },
    unknown: { status: 'default', label: '未知' }
  };

  const meta = statusMap[status] || { status: 'default', label: status };
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

export function renderPolicyBlockedBadge(record: Pick<Account, 'schedulableReason'>) {
  const rawReason = String(record.schedulableReason || '').trim();
  if (!rawReason) return null;
  const reason = formatSchedulableReason(rawReason);
  const meta = (
    rawReason === 'codex_free_plan_below_server_min_remaining'
      ? { status: 'warning' as const, label: 'Free 阈值停池' }
      : rawReason === 'codex_free_plan_missing_rate_limits'
        ? { status: 'warning' as const, label: 'Free 待确认' }
        : rawReason === 'codex_team_plan_missing_rate_limits'
          ? { status: 'warning' as const, label: 'Team 待确认' }
          : rawReason === 'agy_access_token_required'
            ? { status: 'warning' as const, label: '需 Token' }
          : { status: 'warning' as const, label: '已停池' }
  );
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

export function renderQuotaStateBadge(record: Pick<Account, 'quotaStatus' | 'quotaReason'>) {
  const status = String(record.quotaStatus || '').trim();
  if (!status) return null;
  const rawReason = String(record.quotaReason || '').trim();
  const reason = formatQuotaReason(record.quotaReason);
  const meta = (
    status === 'probe_failed' ? { status: 'error' as const, label: '采集失败' }
      : status === 'provider_unavailable' && rawReason === 'codex_team_plan_missing_rate_limits'
        ? { status: 'warning' as const, label: 'Team 待确认' }
        : status === 'provider_unavailable' && rawReason === 'codex_free_plan_missing_rate_limits'
          ? { status: 'warning' as const, label: 'Free 待确认' }
        : status === 'provider_unavailable' ? { status: 'warning' as const, label: '上游未返回' }
        : status === 'pending' ? { status: 'processing' as const, label: '等待采集' }
          : { status: 'default' as const, label: '额度未知' }
  );
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
  if (state === 'usage_attention') {
    return renderQuotaStateBadge(record) || <Badge status="warning" text="额度待确认" />;
  }
  if (state === 'exhausted') {
    return (
      <Badge
        status="error"
        text="已耗尽"
      />
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

export function renderAccountRegionTag(record: Pick<Account, 'provider' | 'region'>) {
  const meta = getAccountRegionMeta(record);
  if (!meta) return null;
  const detail = meta.endpoint
    ? `Kimi Desktop 当前生效区域：${meta.label}（${meta.endpoint}）`
    : '尚未从该账号的 Kimi Desktop profile 读取到有效区域。';
  return (
    <Tooltip title={detail}>
      <Tag color={meta.color} style={accountRoleTagStyle}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}

const accountRoleIconStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 9,
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
          <span style={{ ...accountRoleIconStyle, color: '#722ed1', background: '#f9f0ff' }}>
            <MobileOutlined />
          </span>
        </Tooltip>
      ) : null}
    </Space>
  );
}

export function getPlanTagLabel(record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName'>) {
  // 认证方式只展示一次，避免密钥模式在账号行里重复出现。
  if (record.apiKeyMode) return '密钥';
  // kimi 等 provider 有订阅页品牌档（Allegretto 等），优先于 LEVEL_* 枚举值。
  return record.planName || record.planType || 'free';
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
