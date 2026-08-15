import { formatRuntimeUntil } from '@/components/runtime/RuntimeStatusTag';
import './Accounts.css';
import React, { useState, useEffect, useMemo } from 'react';
import { ModalForm, StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { useLocation } from 'react-router-dom';
import {
  Space,
  Tag,
  Badge,
  Modal,
  Form,
  Input,
  Select,
  Radio,
  Segmented,
  Alert,
  message,
  Card,
  Dropdown,
  Tooltip,
  Collapse,
  Switch,
  Typography,
  Grid,
  Empty,
  Spin,
  Drawer
} from 'antd';
import type { MenuProps } from 'antd';
import MobileStatGrid from '@/components/mobile/MobileStatGrid';
import MobilePills from '@/components/mobile/MobilePills';
import {
  PlusOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  GlobalOutlined,
  ReloadOutlined,
  FilterOutlined,
  MoreOutlined,
  SyncOutlined,
  ExportOutlined,
  ImportOutlined,
  EditOutlined
} from '@ant-design/icons';
import { accountsAPI } from '@/services/account-management/preview';
import {
  ACCOUNT_LIST_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage
} from '@/services/load-failure-message.js';
import { openExternalUrl } from '@/services/open-external-url';
import { formatTimeCell } from '@/utils/datetime';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  AccountImportResponse,
  AccountRefreshJob,
  AccountRemovedEvent,
  Provider,
} from '@/types';
import type {
  AccountModelManualPolicy,
  AccountModelView
} from '@/services/account-management/types.ts';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import { PROVIDER_AUTH_OPTIONS } from '@/providers/catalog';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import TokenUsageCell from '@/components/account/TokenUsageCell';
import {
  getAccountIdentityLabel,
  getAccountSecondaryIdentity,
  isInternalAccountLabel
} from '@/utils/account-labels';
import { formatAccountIssueReason } from '@/utils/account-reasons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

// G1 账号管理只暴露已迁入 Go 单一写入链的 Provider。
const PROVIDERS = ['codex', 'claude'] as const satisfies readonly Provider[];
type SupportedAccountProvider = (typeof PROVIDERS)[number];
type ImportMode = 'file' | 'text';
const ACCOUNT_REMOVE_ANIMATION_MS = 420;
const AUTH_JOB_FALLBACK_POLL_MS = 5000;
const ACCOUNT_REFRESH_FALLBACK_CLEAR_MS = 70_000;
const ACCOUNT_SNAPSHOT_REFRESH_FALLBACK_MS = 70_000;
const MODEL_POLICY_OPTIONS: Array<{ label: string; value: AccountModelManualPolicy }> = [
  { label: '跟随上游', value: 'inherit' },
  { label: '强制启用', value: 'force_enable' },
  { label: '强制停用', value: 'force_disable' }
];

type CallbackUiCopy = {
  hint: string;
  placeholder: string;
  submitLabel: string;
  emptyWarning: string;
  submitSuccess: string;
};

// Codex 和 Claude 共用浏览器 OAuth + 手动回调地址的收口。
function getCallbackUiCopy(): CallbackUiCopy {
  return {
    hint: '同一台机器会自动接收回调；如果是远端访问，浏览器停在回调页或显示无法连接时，把地址栏完整地址粘贴到这里。只有本次授权链接的 state 才会被接受。',
    placeholder: '粘贴完整回调地址，或只粘贴 ?code=...&state=...',
    submitLabel: '提交回调',
    emptyWarning: '请粘贴回调地址',
    submitSuccess: '回调已提交，正在确认授权结果'
  };
}

const SUB2API_TEMPLATE = JSON.stringify({
  type: 'sub2api-data',
  version: 1,
  proxies: [],
  accounts: []
}, null, 2);

function validateSub2APIContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new Error('请提供 sub2api JSON');
  let payload: unknown;
  try {
    payload = JSON.parse(normalized);
  } catch (_error) {
    throw new Error('文件内容不是有效 JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('导入内容必须是单份 sub2api JSON 对象');
  }
  if ((payload as { type?: unknown }).type !== 'sub2api-data') {
    throw new Error('仅支持 type 为 sub2api-data 的迁移 JSON');
  }
  return normalized;
}

function getAccountPrimaryLabel(record: Account) {
  return getAccountIdentityLabel(record);
}

function getAccountSecondaryLabel(record: Account) {
  return getAccountSecondaryIdentity(record);
}



function isClaudeAuthTokenMode(value?: string) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'auth-token' || normalized === 'claude-code-token';
}

function getClaudeCredentialMode(record?: Pick<Account, 'authMode' | 'authType' | 'credentialType'> | null): AccountAuthMode {
  return isClaudeAuthTokenMode(record?.credentialType || record?.authType || record?.authMode)
    ? 'auth-token'
    : 'api-key';
}

function getSupportedAuthOptions(provider: SupportedAccountProvider) {
  return (PROVIDER_AUTH_OPTIONS[provider] || []).filter((option) => (
    provider !== 'codex' || option.value !== 'oauth-device'
  ));
}

function formatImportResult(result: AccountImportResponse) {
  const summary = result.summary;
  const imported = Number(summary?.imported ?? result.imported ?? 0);
  if (!summary) return `导入完成，写入 ${imported} 个账号`;

  const parts = [`写入 ${imported}`];
  if (summary.created > 0) parts.push(`新增 ${summary.created}`);
  if (summary.updated > 0) parts.push(`更新 ${summary.updated}`);
  if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped}`);
  if (summary.invalid > 0) parts.push(`无效 ${summary.invalid}`);
  if (summary.failed > 0) parts.push(`失败 ${summary.failed}`);
  return `导入完成：${parts.join('，')}`;
}

function canCopyAccountEmail(record: Pick<Account, 'apiKeyMode' | 'email' | 'baseUrl'>) {
  if (record.apiKeyMode) {
    return true; // API Key 账号始终展示复制按钮
  }
  return Boolean(String(record.email || '').trim());
}

function hasBlockingRuntimeStatus(record: Pick<Account, 'runtimeStatus'>) {
  const status = String(record.runtimeStatus || '').trim();
  return Boolean(status && status !== 'healthy');
}

function isAccountEnabled(record: Pick<Account, 'status'>) {
  return String(record.status || 'up').trim().toLowerCase() !== 'down';
}

type AccountDisplayStateKind =
  | 'healthy'
  | 'exhausted'
  | 'policy_blocked'
  | 'usage_attention'
  | 'runtime_blocked'
  | 'disabled'
  | 'unconfigured';

type AccountFilterValue =
  | 'all'
  | 'healthy'
  | 'exhausted'
  | 'policy_blocked'
  | 'usage_attention'
  | 'runtime_blocked'
  | 'disabled'
  | 'unconfigured';

type AccountProviderFilter = 'all' | SupportedAccountProvider;

type ProviderStatsBucket = {
  total: number;
  healthy: number;
  exhausted: number;
  policyBlocked: number;
  usageAttention: number;
  runtimeBlocked: number;
  disabled: number;
  unconfigured: number;
};

type ProviderStats = Record<AccountProviderFilter, ProviderStatsBucket>;

function createProviderStatsBucket(): ProviderStatsBucket {
  return {
    total: 0,
    healthy: 0,
    exhausted: 0,
    policyBlocked: 0,
    usageAttention: 0,
    runtimeBlocked: 0,
    disabled: 0,
    unconfigured: 0
  };
}

function createProviderStats(): ProviderStats {
  return {
    all: createProviderStatsBucket(),
    codex: createProviderStatsBucket(),
    claude: createProviderStatsBucket()
  };
}

function isSupportedAccountProvider(value: string): value is SupportedAccountProvider {
  return value === 'codex' || value === 'claude';
}

const ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY = 'accounts-active-provider-tab:v1';

function readStoredActiveProviderTab(): AccountProviderFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const saved = window.localStorage.getItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY);
    if (saved === 'all' || isSupportedAccountProvider(saved || '')) return saved as AccountProviderFilter;
  } catch (_error) {
    // localStorage 不可用（隐私模式等）时静默回退到默认 tab。
  }
  return 'all';
}

function persistActiveProviderTab(provider: AccountProviderFilter): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY, provider); } catch (_error) {}
}

function getAccountDisplayState(record: Pick<Account, 'status' | 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus' | 'remainingPct' | 'provider' | 'usageSnapshot'>): AccountDisplayStateKind {
  if (!isAccountEnabled(record)) return 'disabled';
  if (!record.configured) return 'unconfigured';
  if (hasBlockingRuntimeStatus(record)) return 'runtime_blocked';
  const effectiveRemainingPct = getEffectiveRemainingPct(record);
  if (!record.apiKeyMode && effectiveRemainingPct != null && effectiveRemainingPct <= 0) return 'exhausted';
  if (String(record.quotaStatus || '').trim() === 'exhausted') return 'exhausted';
  if (String(record.schedulableStatus || '').trim() === 'blocked_by_policy') return 'policy_blocked';
  if (
    String(record.quotaStatus || '').trim()
    && !['available', 'not_applicable', 'exhausted'].includes(String(record.quotaStatus || '').trim())
  ) {
    return 'usage_attention';
  }
  if (String(record.quotaStatus || '').trim() === 'not_applicable') return 'healthy';
  if (!record.apiKeyMode && !hasKnownUsage(record)) return 'usage_attention';
  return 'healthy';
}

function canRefreshUsageAccount(record: Pick<Account, 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus'>) {
  // OAuth 已配置账号始终允许手动刷新用量,不再依赖已有额度状态。
  if (String(record.quotaStatus || '').trim() === 'not_applicable') return false;
  return Boolean(record.configured) && !record.apiKeyMode;
}

function canReauthAccount(record: Pick<Account, 'apiKeyMode'>) {
  return !record.apiKeyMode;
}

function getReauthActionLabel(record: Pick<Account, 'configured' | 'authPending' | 'authPendingStale'>) {
  if (record.authPending && !record.authPendingStale) return '继续授权';
  if (!record.configured) return '重新授权';
  return '重新登录';
}

function canEditAccountConfig(record: Pick<Account, 'apiKeyMode'>) {
  return Boolean(record.apiKeyMode);
}

function hasKnownUsage(record: Pick<Account, 'apiKeyMode' | 'remainingPct' | 'provider' | 'usageSnapshot'>) {
  if (record.apiKeyMode) return false;
  return getEffectiveRemainingPct(record) != null;
}

function getUsageSnapshotRemainingPct(record: Pick<Account, 'provider' | 'usageSnapshot'>) {
  const snapshot = record.usageSnapshot;
  if (!snapshot) return null;
  let values: number[] = [];
  if (
    (record.provider === 'codex' && snapshot.kind === 'codex_oauth_status')
    || (record.provider === 'claude' && snapshot.kind === 'claude_oauth_usage')
    || (record.provider === 'kimi' && snapshot.kind === 'kimi_oauth_usage')
  ) {
    values = (snapshot.entries || [])
      .map((entry) => Number(entry.remainingPct))
      .filter((value) => Number.isFinite(value));
  } else if (
    (record.provider === 'gemini' && snapshot.kind === 'gemini_oauth_stats')
    || (record.provider === 'agy' && snapshot.kind === 'agy_code_assist_quota')
  ) {
    values = (snapshot.models || [])
      .map((model) => Number(model.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  if (values.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...values)));
}

function getEffectiveRemainingPct(record: Pick<Account, 'provider' | 'remainingPct' | 'usageSnapshot'>) {
  const snapshotRemaining = getUsageSnapshotRemainingPct(record);
  if (snapshotRemaining != null) return snapshotRemaining;
  if (record.remainingPct == null) return null;
  const numeric = Number(record.remainingPct);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function getUsageSortValue(record: Pick<Account, 'provider' | 'remainingPct' | 'usageSnapshot'>) {
  return getEffectiveRemainingPct(record) ?? -1;
}

function formatQuotaReason(reason?: string) {
  return formatAccountIssueReason(reason);
}

function formatSchedulableReason(reason?: string) {
  const text = String(reason || '').trim();
  if (!text) return '';
  if (text === 'codex_free_plan_missing_rate_limits') {
    return '当前账号已被判定为 Free，但 Codex 没返回可计算额度窗口；server 暂不把它放进账号池，建议重新登录确认。';
  }
  if (text === 'codex_team_plan_missing_rate_limits') {
    return '当前账号 token claim 仍是 Team，但 Codex 没返回可计算额度窗口；server 暂不把它放进账号池，建议重新登录确认。';
  }
  if (text === 'agy_access_token_required') {
    return 'Antigravity OAuth token 在系统 keyring 中，aih server 不能安全读取；需要在账号环境中显式配置 AGY_ACCESS_TOKEN 后才会进入聊天/转发池。';
  }
  return formatAccountIssueReason(text);
}

function renderRuntimeStatusBadge(record: Pick<Account, 'runtimeStatus' | 'runtimeReason' | 'runtimeUntil'>) {
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

function renderPolicyBlockedBadge(record: Pick<Account, 'schedulableReason'>) {
  const rawReason = String(record.schedulableReason || '').trim();
  if (!rawReason) return null;
  const reason = formatSchedulableReason(rawReason);
  const meta = (
    rawReason === 'codex_free_plan_missing_rate_limits'
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

function renderQuotaStateBadge(record: Pick<Account, 'quotaStatus' | 'quotaReason'>) {
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

function renderAccountDisplayBadge(record: Account) {
  if (!record.configured && record.authPendingStale) return <Badge status="warning" text="授权超时" />;
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

function renderAccountRoleTags(record: Pick<Account, 'isDefault'>) {
  if (!record.isDefault) return null;
  return (
    <>
      {record.isDefault ? (
        <Tooltip title="默认账号">
          <Tag color="blue" icon={<CheckCircleOutlined />} style={accountRoleTagStyle}>
            默认
          </Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

function renderAccountRoleIcons(record: Pick<Account, 'isDefault'>) {
  if (!record.isDefault) return null;
  return (
    <Space size={4} style={{ flex: '0 0 auto' }}>
      {record.isDefault ? (
        <Tooltip title="当前默认账号">
          <span style={{ ...accountRoleIconStyle, color: 'var(--color-info)', background: 'var(--color-info-soft)' }}>
            <CheckCircleOutlined />
          </span>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function getPlanTagLabel(record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName'>) {
  // 认证方式只展示一次，避免密钥模式在账号行里重复出现。
  if (record.apiKeyMode) return '密钥';
  // kimi 等 provider 有订阅页品牌档（Allegretto 等），优先于 LEVEL_* 枚举值。
  return record.planName || record.planType || 'free';
}

function getPlanTagColor(record: Pick<Account, 'apiKeyMode' | 'planType' | 'planName'>) {
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

function getAccountRef(record: Pick<Account, 'accountRef'>) {
  return String(record.accountRef || '').trim();
}

type AccountModelProbe = {
  probed: boolean;
  modelCount: number;
  error: string;
};

type AccountModelProbeMap = Record<string, AccountModelProbe>;

function getAccountModelProbe(record: Account, probes: AccountModelProbeMap) {
  const accountRef = getAccountRef(record);
  const current = probes[accountRef];
  if (current) {
    if (current.error && record.modelSummary) {
      return {
        ...current,
        probed: true,
        modelCount: record.modelSummary.effectiveCount
      };
    }
    return current;
  }
  if (record.modelSummary) {
    return {
      probed: true,
      modelCount: record.modelSummary.effectiveCount,
      error: ''
    };
  }
  return { probed: false, modelCount: 0, error: '' };
}

function formatModelProbeErrorLabel(error: string) {
  const normalized = String(error || '').trim();
  if (!normalized) return '探测失败';
  const httpMatch = normalized.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) return `${httpMatch[1]} 失败`;
  if (normalized.includes('PERMISSION_DENIED')) return '权限拒绝';
  if (normalized.includes('UND_ERR')) return '网络失败';
  return '探测失败';
}

function getModelProbeTagLabel(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.modelCount > 0) return `模型 ${probe.modelCount}`;
  if (probe.error) return formatModelProbeErrorLabel(probe.error);
  if (modelRefreshing) return '探测中';
  if (probe.probed) return '未发现模型';
  return '未知';
}

function getModelProbeTagColor(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.modelCount > 0) return probe.error ? 'warning' : 'success';
  if (probe.error) return 'error';
  if (modelRefreshing) return 'processing';
  return probe.probed ? 'default' : 'default';
}

function mergeAccountRecord(
  current: Account,
  incoming: Account,
  options: { preserveLiveFields?: boolean } = {}
): Account {
  const fallbackDisplayName = incoming.accountRef;
  const merged: Account = {
    ...current,
    ...incoming
  };

  if (merged.apiKeyMode) {
    // Go 基础投影没有运行态证据时必须保留 unknown，不能因为是密钥账号就伪装成可调度。
    merged.runtimeStatus = incoming.runtimeStatus || 'unknown';
    merged.runtimeUntil = incoming.runtimeUntil;
    merged.runtimeReason = incoming.runtimeReason;
    merged.usageSnapshot = null;
    merged.remainingPct = null;
    merged.quotaStatus = incoming.quotaStatus || 'unknown';
    merged.quotaReason = incoming.quotaReason;
    merged.schedulableStatus = incoming.schedulableStatus || 'unknown';
    merged.schedulableReason = incoming.schedulableReason;
    return merged;
  }

  if (!merged.configured || merged.apiKeyMode) {
    return merged;
  }

  if (!incoming.email && current.email) {
    merged.email = current.email;
  }
  if (options.preserveLiveFields) {
    if ((incoming.updatedAt == null || incoming.updatedAt <= 0) && current.updatedAt > 0) {
      merged.updatedAt = current.updatedAt;
    }
    if ((incoming.lastUsedAt == null || incoming.lastUsedAt <= 0) && current.lastUsedAt && current.lastUsedAt > 0) {
      merged.lastUsedAt = current.lastUsedAt;
    }
    if (!incoming.usageSnapshot && current.usageSnapshot) {
      merged.usageSnapshot = current.usageSnapshot;
    }
    if ((incoming.remainingPct == null) && current.remainingPct != null) {
      merged.remainingPct = current.remainingPct;
    }
    if (incoming.runtimeStatus == null && current.runtimeStatus != null) {
      merged.runtimeStatus = current.runtimeStatus;
    }
    if (incoming.runtimeUntil == null && current.runtimeUntil != null) {
      merged.runtimeUntil = current.runtimeUntil;
    }
    if (incoming.runtimeReason == null && current.runtimeReason != null) {
      merged.runtimeReason = current.runtimeReason;
    }
    if (incoming.quotaStatus == null && current.quotaStatus != null) {
      merged.quotaStatus = current.quotaStatus;
    }
    if (incoming.quotaReason == null && current.quotaReason != null) {
      merged.quotaReason = current.quotaReason;
    }
    if (incoming.schedulableStatus == null && current.schedulableStatus != null) {
      merged.schedulableStatus = current.schedulableStatus;
    }
    if (incoming.schedulableReason == null && current.schedulableReason != null) {
      merged.schedulableReason = current.schedulableReason;
    }
  }
  if (
    (!incoming.planType || incoming.planType === 'oauth' || incoming.planType === 'pending')
    && current.planType
    && current.planType !== 'oauth'
    && current.planType !== 'pending'
  ) {
    merged.planType = current.planType;
  }
  if ((!incoming.displayName || incoming.displayName === fallbackDisplayName || isInternalAccountLabel(incoming.displayName)) && current.displayName) {
    merged.displayName = current.displayName;
  }

  return merged;
}

export default function Accounts() {
  const { Paragraph, Text } = Typography;
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const location = useLocation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [hydratingDetails, setHydratingDetails] = useState(false);
  const [removingAccountRefs, setRemovingAccountRefs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingStatusAccountRefs, setUpdatingStatusAccountRefs] = useState<Record<string, boolean>>({});
  const [refreshingUsageAccountRefs, setRefreshingUsageAccountRefs] = useState<Record<string, boolean>>({});
  const [modalVisible, setModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addJobId, setAddJobId] = useState<string | null>(null);
  const [addJob, setAddJob] = useState<AccountAddJob | null>(null);
  const [authProgressVisible, setAuthProgressVisible] = useState(false);
  const [authSuccessClosing, setAuthSuccessClosing] = useState(false);
  const [authFlowKind, setAuthFlowKind] = useState<'add' | 'reauth'>('add');
  const [authSubjectLabel, setAuthSubjectLabel] = useState('');
  const [authCallbackUrl, setAuthCallbackUrl] = useState('');
  const [authCallbackSubmitting, setAuthCallbackSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>(() => readStoredActiveProviderTab());
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [acctFilterOpen, setAcctFilterOpen] = useState(false);
  const [actionAccount, setActionAccount] = useState<Account | null>(null);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('file');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importFileContent, setImportFileContent] = useState('');
  const [importingAccounts, setImportingAccounts] = useState(false);
  const [exportingAccountRef, setExportingAccountRef] = useState<string | null>(null);
  const [modelProbes, setModelProbes] = useState<AccountModelProbeMap>({});
  const [refreshingModelAccountRefs, setRefreshingModelAccountRefs] = useState<Record<string, boolean>>({});
  const [modelManagementAccount, setModelManagementAccount] = useState<Account | null>(null);
  const [modelManagementModels, setModelManagementModels] = useState<AccountModelView[]>([]);
  const [modelManagementLoading, setModelManagementLoading] = useState(false);
  const [modelPolicyUpdating, setModelPolicyUpdating] = useState<string | null>(null);
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const removingAccountTimersRef = React.useRef<Record<string, number>>({});
  const completedAuthJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedRefreshJobKeysRef = React.useRef<Set<string>>(new Set());
  const refreshingUsageFallbackTimersRef = React.useRef<Record<string, number>>({});
  const accountsSnapshotFallbackTimerRef = React.useRef<number | null>(null);
  const accountsRef = React.useRef<Account[]>([]);
  // 删除确认可能因重复点击或热更新产生多个回调；同一账号只允许一个破坏性操作在途。
  const deletingAccountRefsRef = React.useRef<Set<string>>(new Set());
  const modelManagementRequestRef = React.useRef(0);
  const hasLoadedAccountsRef = React.useRef(false);
  const accountsSnapshotRevisionRef = React.useRef(0);
  const accountsLoadRequestRef = React.useRef(0);
  const previousAddProviderRef = React.useRef<SupportedAccountProvider | undefined>(undefined);
  const selectedProvider = Form.useWatch('provider', form) as SupportedAccountProvider | undefined;
  const selectedAuthMode = Form.useWatch('authMode', form) as AccountAuthMode | undefined;
  const selectedEditAuthMode = Form.useWatch('authMode', editForm) as AccountAuthMode | undefined;
  const providerAuthOptions = selectedProvider
    ? getSupportedAuthOptions(selectedProvider)
    : [];
  const editingClaudeCredentialMode = editingAccount?.provider === 'claude'
    ? getClaudeCredentialMode(editingAccount)
    : 'api-key';
  const effectiveEditAuthMode = selectedEditAuthMode || editingClaudeCredentialMode;
  const isEditingClaudeCredential = editingAccount?.provider === 'claude';
  const accountRouteTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const provider = String(params.get('provider') || '').trim();
    const accountRef = String(params.get('accountRef') || '').trim();
    if (!isSupportedAccountProvider(provider) || !accountRef) return null;
    return {
      provider,
      accountRef
    };
  }, [location.search]);

  const copyAccountEmail = React.useCallback(async (record: Pick<Account, 'apiKeyMode' | 'email' | 'baseUrl' | 'accountRef'>) => {
    if (!canCopyAccountEmail(record)) return;
    const text = record.apiKeyMode
      ? (String(record.baseUrl || '').trim() || record.accountRef)
      : String(record.email || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success('账号已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  }, []);

  const copyText = React.useCallback(async (value: string, successMessage: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(successMessage);
    } catch (_error) {
      message.error('复制失败');
    }
  }, []);

  const openAuthLink = React.useCallback(async (value?: string) => {
    const target = String(value || '').trim();
    if (!target) return;
    try {
      await openExternalUrl(target);
    } catch (_error) {
      message.error('无法打开授权链接');
    }
  }, []);

  const mergeAccounts = React.useCallback((
    current: Account[],
    incoming: Account[],
    options: { preserveLiveFields?: boolean } = {}
  ) => {
    const currentMap = new Map<string, Account>(
      current.map((account) => [getAccountRef(account), account])
    );
    const nextMap = new Map<string, Account>();
    incoming.forEach((account) => {
      const key = getAccountRef(account);
      const previous = currentMap.get(key);
      nextMap.set(key, previous ? mergeAccountRecord(previous, account, options) : account);
    });
    return Array.from(nextMap.values());
  }, []);

  const mergeSingleAccount = React.useCallback((current: Account[], incoming: Account) => {
    const next = current.slice();
    const key = getAccountRef(incoming);
    const index = next.findIndex((account) => getAccountRef(account) === key);
    if (index >= 0) {
      next[index] = mergeAccountRecord(next[index], incoming);
      return next;
    }
    next.push(incoming);
    return next;
  }, []);

  const clearAccountUsageRefresh = React.useCallback((accountRef: string) => {
    const key = String(accountRef || '').trim();
    if (!key) return;
    const timer = refreshingUsageFallbackTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete refreshingUsageFallbackTimersRef.current[key];
    }
    setRefreshingUsageAccountRefs((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const trackAccountUsageRefresh = React.useCallback((accountRef: string) => {
    const key = String(accountRef || '').trim();
    if (!key) return;
    setRefreshingUsageAccountRefs((current) => ({
      ...current,
      [key]: true
    }));
    const existingTimer = refreshingUsageFallbackTimersRef.current[key];
    if (existingTimer) window.clearTimeout(existingTimer);
    refreshingUsageFallbackTimersRef.current[key] = window.setTimeout(() => {
      clearAccountUsageRefresh(key);
    }, ACCOUNT_REFRESH_FALLBACK_CLEAR_MS);
  }, [clearAccountUsageRefresh]);

  const clearAccountsSnapshotRefresh = React.useCallback(() => {
    if (accountsSnapshotFallbackTimerRef.current !== null) {
      window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
      accountsSnapshotFallbackTimerRef.current = null;
    }
    setRefreshing(false);
  }, []);

  const trackAccountsSnapshotRefresh = React.useCallback(() => {
    setRefreshing(true);
    setHydratingDetails(true);
    if (accountsSnapshotFallbackTimerRef.current !== null) {
      window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
    }
    accountsSnapshotFallbackTimerRef.current = window.setTimeout(() => {
      accountsSnapshotFallbackTimerRef.current = null;
      setRefreshing(false);
      setHydratingDetails(false);
    }, ACCOUNT_SNAPSHOT_REFRESH_FALLBACK_MS);
  }, []);

  const cancelAccountRemoval = React.useCallback((accountRef: string) => {
    const key = String(accountRef || '').trim();
    if (!key) return;
    const timer = removingAccountTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete removingAccountTimersRef.current[key];
    }
    setRemovingAccountRefs((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const stageAccountRemoval = React.useCallback((target: Pick<Account, 'accountRef'>) => {
    const accountRef = getAccountRef(target);
    if (!accountRef) return;
    clearAccountUsageRefresh(accountRef);
    setRemovingAccountRefs((current) => (
      current[accountRef] ? current : { ...current, [accountRef]: true }
    ));
    const currentTimer = removingAccountTimersRef.current[accountRef];
    if (currentTimer) window.clearTimeout(currentTimer);
    removingAccountTimersRef.current[accountRef] = window.setTimeout(() => {
      setAccounts((current) => current.filter((account) => getAccountRef(account) !== accountRef));
      setRemovingAccountRefs((current) => {
        if (!current[accountRef]) return current;
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
      setRefreshingUsageAccountRefs((current) => {
        if (!current[accountRef]) return current;
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
      setUpdatingStatusAccountRefs((current) => {
        if (!current[accountRef]) return current;
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
      delete removingAccountTimersRef.current[accountRef];
    }, ACCOUNT_REMOVE_ANIMATION_MS);
  }, [clearAccountUsageRefresh]);

  const applyAccountsSnapshot = React.useCallback((
    snapshotAccounts: Account[],
    options: { preserveLiveFields?: boolean } = {}
  ) => {
    const incoming = Array.isArray(snapshotAccounts) ? snapshotAccounts : [];
    const incomingRefs = new Set(incoming.map((account) => getAccountRef(account)));
    accountsRef.current
      .filter((account) => !incomingRefs.has(getAccountRef(account)))
      .forEach((account) => stageAccountRemoval(account));

    // 新列表已携带数据库模型汇总时，丢弃旧的成功临时值；失败提示继续覆盖在 LKG 计数上。
    setModelProbes((current) => {
      let changed = false;
      const next = { ...current };
      incomingRefs.forEach((accountRef) => {
        if (next[accountRef] && !next[accountRef].error) {
          delete next[accountRef];
          changed = true;
        }
      });
      return changed ? next : current;
    });

    setAccounts((current) => {
      const next = mergeAccounts(current, incoming, options);
      const nextRefs = new Set(next.map((account) => getAccountRef(account)));
      const exiting = current.filter((account) => {
        const key = getAccountRef(account);
        return Boolean(removingAccountTimersRef.current[key]) && !nextRefs.has(key);
      });
      return [...next, ...exiting];
    });
  }, [mergeAccounts, stageAccountRemoval]);

  const closeAuthProgressPanel = React.useCallback(() => {
    if (successAutoCloseTimerRef.current !== null) {
      window.clearTimeout(successAutoCloseTimerRef.current);
      successAutoCloseTimerRef.current = null;
    }
    setAuthSuccessClosing(false);
    setAddJobId(null);
    setAddJob(null);
    setAuthFlowKind('add');
    setAuthSubjectLabel('');
    setAuthCallbackUrl('');
    setAuthCallbackSubmitting(false);
    setAuthProgressVisible(false);
  }, []);

  const canSubmitImport = importMode === 'text'
    ? Boolean(importText.trim())
    : Boolean(importFileContent.trim());

  const resetImportState = React.useCallback(() => {
    setImportText('');
    setImportFileName('');
    setImportFileContent('');
    if (importInputRef.current) importInputRef.current.value = '';
  }, []);

  const closeImportModal = React.useCallback(() => {
    if (importingAccounts) return;
    setImportModalVisible(false);
    resetImportState();
  }, [importingAccounts, resetImportState]);

  const handleExportAccount = async (record: Account) => {
    const accountRef = getAccountRef(record);
    setExportingAccountRef(accountRef);
    try {
      await accountsAPI.exportAccount(accountRef);
      message.success('迁移 JSON 已导出');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '导出失败');
    } finally {
      setExportingAccountRef(null);
    }
  };

  const handleImportModeChange = (value: string | number) => {
    const nextMode = value as ImportMode;
    setImportMode(nextMode);
    if (nextMode !== 'text') setImportText('');
    if (nextMode !== 'file') {
      setImportFileName('');
      setImportFileContent('');
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = validateSub2APIContent(await file.text());
      setImportFileName(file.name);
      setImportFileContent(content);
    } catch (error: any) {
      setImportFileName('');
      setImportFileContent('');
      event.target.value = '';
      message.error(error?.message || '读取导入文件失败');
    }
  };

  const handleImportSubmit = async () => {
    if (!canSubmitImport) {
      message.warning(importMode === 'text' ? '请粘贴导入内容' : '请选择导入文件');
      return;
    }
    setImportingAccounts(true);
    try {
      const content = validateSub2APIContent(
        importMode === 'file' ? importFileContent : importText
      );
      const result = await accountsAPI.import({ content });
      const failedCount = Number(result.summary?.failed || 0) + Number(result.summary?.invalid || 0);
      const notify = Number(result.imported || 0) > 0 && failedCount === 0
        ? message.success
        : message.warning;
      notify(formatImportResult(result));
      setImportModalVisible(false);
      resetImportState();
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '导入失败');
    } finally {
      setImportingAccounts(false);
    }
  };

  const handleEdit = (record: Account) => {
    if (!canEditAccountConfig(record)) {
      message.warning('OAuth 账号请使用重新登录更新授权');
      return;
    }
    setEditingAccount(record);
    editForm.setFieldsValue({
      authMode: record.provider === 'claude' ? getClaudeCredentialMode(record) : 'api-key',
      apiKey: '',
      baseUrl: record.baseUrl || ''
    });
    setEditModalVisible(true);
  };

  const handleEditSubmit = async (): Promise<boolean> => {
    try {
      const values = await editForm.validateFields();
      if (!editingAccount) return false;
      setSubmitting(true);
      const res = await accountsAPI.updateAccount(editingAccount.provider, editingAccount.accountRef, {
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        ...(editingAccount.provider === 'claude'
          ? {
              authMode: values.authMode,
              credentialType: values.authMode
            }
          : {})
      });
      if (res.ok) {
        message.success('更新成功');
        setAccounts((prev) => mergeSingleAccount(prev, res.account));
        setEditModalVisible(false);
        return true;
      }
      return false;
    } catch (error: any) {
      if (error.errorFields) return false;
      message.error(error.response?.data?.message || '更新失败');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const loadAccounts = React.useCallback(async () => {
    const requestId = ++accountsLoadRequestRef.current;
    const snapshotRevision = accountsSnapshotRevisionRef.current;
    if (hasLoadedAccountsRef.current) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await accountsAPI.list();
      if (
        requestId !== accountsLoadRequestRef.current
        || snapshotRevision !== accountsSnapshotRevisionRef.current
      ) return;
      clearLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY);
      applyAccountsSnapshot(payload.accounts, {
        preserveLiveFields: Boolean(payload.hydrating)
      });
      setHydratingDetails(Boolean(payload.hydrating));
      hasLoadedAccountsRef.current = true;
    } catch (_error) {
      if (
        requestId === accountsLoadRequestRef.current
        && snapshotRevision === accountsSnapshotRevisionRef.current
      ) {
        showLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY, '加载账号失败');
      }
    } finally {
      if (requestId === accountsLoadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyAccountsSnapshot]);

  const markModelAccountRefreshing = React.useCallback((accountRef: string) => {
    if (!accountRef) return;
    setRefreshingModelAccountRefs((current) => ({ ...current, [accountRef]: true }));
  }, []);

  const clearModelAccountRefreshing = React.useCallback((accountRef: string) => {
    if (!accountRef) return;
    setRefreshingModelAccountRefs((current) => {
      if (!current[accountRef]) return current;
      const next = { ...current };
      delete next[accountRef];
      return next;
    });
  }, []);

  const forgetModelProbe = React.useCallback((accountRef: string) => {
    if (!accountRef) return;
    setModelProbes((current) => {
      if (!current[accountRef]) return current;
      const next = { ...current };
      delete next[accountRef];
      return next;
    });
  }, []);

  const refreshAccountModelCatalog = React.useCallback(async (record: Account) => {
    const accountRef = getAccountRef(record);
    if (!accountRef) {
      message.error('账号缺少公开引用，请重新加载账号列表后再刷新');
      return;
    }
    markModelAccountRefreshing(accountRef);
    try {
      const models = await accountsAPI.refreshAccountModels(accountRef);
      setModelProbes((current) => ({
        ...current,
        [accountRef]: {
          probed: true,
          modelCount: models.filter((model) => model.effective).length,
          error: ''
        }
      }));
      message.success('账号模型目录已刷新');
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || '账号模型刷新失败';
      // Go 刷新失败会保留最后成功快照，页面同样不用失败结果覆盖已知模型。
      setModelProbes((current) => ({
        ...current,
        [accountRef]: {
          ...(current[accountRef] || {
            probed: Boolean(record.modelSummary),
            modelCount: record.modelSummary?.effectiveCount || 0
          }),
          error: errorMessage
        }
      }));
      message.error(errorMessage);
    } finally {
      clearModelAccountRefreshing(accountRef);
    }
  }, [clearModelAccountRefreshing, markModelAccountRefreshing]);

  // openModelManagement 只在用户明确展开一个账号时读取模型，避免账号列表产生 N+1。
  const openModelManagement = React.useCallback(async (record: Account) => {
    const accountRef = getAccountRef(record);
    if (!accountRef) {
      message.error('账号缺少公开引用，请重新加载账号列表后再管理模型');
      return;
    }
    const requestId = ++modelManagementRequestRef.current;
    setModelManagementAccount(record);
    setModelManagementModels([]);
    setModelManagementLoading(true);
    try {
      const models = await accountsAPI.listAccountModels(accountRef);
      if (requestId !== modelManagementRequestRef.current) return;
      setModelManagementModels(models);
      setModelProbes((current) => ({
        ...current,
        [accountRef]: {
          probed: true,
          modelCount: models.filter((model) => model.effective).length,
          error: ''
        }
      }));
    } catch (error: any) {
      if (requestId !== modelManagementRequestRef.current) return;
      message.error(error?.response?.data?.message || error?.message || '读取账号模型失败');
    } finally {
      if (requestId === modelManagementRequestRef.current) setModelManagementLoading(false);
    }
  }, []);

  // closeModelManagement 使迟到的列表响应不能重新打开或覆盖当前抽屉。
  const closeModelManagement = React.useCallback(() => {
    modelManagementRequestRef.current += 1;
    setModelManagementAccount(null);
    setModelManagementModels([]);
    setModelManagementLoading(false);
    setModelPolicyUpdating(null);
  }, []);

  // refreshModelManagement 在抽屉内显式触发一次真实目录刷新，并保留完整策略快照。
  const refreshModelManagement = React.useCallback(async () => {
    const record = modelManagementAccount;
    const accountRef = getAccountRef(record || { accountRef: '' });
    if (!record || !accountRef) return;
    const requestId = ++modelManagementRequestRef.current;
    setModelManagementLoading(true);
    try {
      const models = await accountsAPI.refreshAccountModels(accountRef);
      if (requestId !== modelManagementRequestRef.current) return;
      setModelManagementModels(models);
      setModelProbes((current) => ({
        ...current,
        [accountRef]: {
          probed: true,
          modelCount: models.filter((model) => model.effective).length,
          error: ''
        }
      }));
      message.success('账号模型目录已刷新');
    } catch (error: any) {
      if (requestId !== modelManagementRequestRef.current) return;
      message.error(error?.response?.data?.message || error?.message || '账号模型刷新失败');
    } finally {
      if (requestId === modelManagementRequestRef.current) setModelManagementLoading(false);
    }
  }, [modelManagementAccount]);

  // updateModelPolicy 使用 Go 返回的完整快照替换抽屉内容，不局部拼接模型关系。
  const updateModelPolicy = React.useCallback(async (
    modelId: string,
    manualPolicy: AccountModelManualPolicy
  ) => {
    const record = modelManagementAccount;
    const accountRef = getAccountRef(record || { accountRef: '' });
    if (!record || !accountRef || !modelId) return;
    setModelPolicyUpdating(modelId);
    try {
      const models = await accountsAPI.setAccountModelPolicy(accountRef, modelId, manualPolicy);
      if (getAccountRef(modelManagementAccount || { accountRef: '' }) !== accountRef) return;
      setModelManagementModels(models);
      setModelProbes((current) => ({
        ...current,
        [accountRef]: {
          probed: true,
          modelCount: models.filter((model) => model.effective).length,
          error: ''
        }
      }));
      message.success(`模型 ${modelId} 策略已更新`);
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '模型策略更新失败');
    } finally {
      setModelPolicyUpdating(null);
    }
  }, [modelManagementAccount]);

  const requestAccountsSnapshotUpdate = React.useCallback(async (options: {
    announce?: boolean;
    failureMessage?: string;
  } = {}) => {
    trackAccountsSnapshotRefresh();
    try {
      const response = await accountsAPI.requestSnapshot();
      if (options.announce) {
        message.info(response.alreadyRunning ? '账号重新加载已在进行' : '账号重新加载已开始');
      }
      return response;
    } catch (error: any) {
      clearAccountsSnapshotRefresh();
      setHydratingDetails(false);
      message.error(error?.response?.data?.message || error?.message || options.failureMessage || '刷新账号列表失败');
      return null;
    }
  }, [clearAccountsSnapshotRefresh, trackAccountsSnapshotRefresh]);

  const handleAuthJobUpdate = React.useCallback((job: AccountAddJob) => {
    const jobId = String(job?.id || '').trim();
    if (!jobId) return;

    setAddJob((current) => {
      if (!current && addJobId !== jobId && !authProgressVisible) return current;
      if (current && current.id !== jobId) return current;
      return job;
    });

    if (addJobId !== jobId && !authProgressVisible) return;

    if (job.status === 'running') {
      setAddJobId(jobId);
      return;
    }

    setAddJobId((current) => (current === jobId ? null : current));

    if (job.status === 'succeeded') {
      if (completedAuthJobKeysRef.current.has(jobId)) return;
      completedAuthJobKeysRef.current.add(jobId);
      const successLabel = getAuthJobIdentity(job) || authSubjectLabel || '账号';
      void requestAccountsSnapshotUpdate();
      if (!authSuccessClosing) {
        setAuthSuccessClosing(true);
        message.success(
          authFlowKind === 'reauth'
            ? `${successLabel} 重新认证成功`
            : `${successLabel} 授权完成`
        );
        if (successAutoCloseTimerRef.current !== null) {
          window.clearTimeout(successAutoCloseTimerRef.current);
        }
        successAutoCloseTimerRef.current = window.setTimeout(() => {
          closeAuthProgressPanel();
        }, 3000);
      }
    }
  }, [
    addJobId,
    authFlowKind,
    authProgressVisible,
    authSubjectLabel,
    authSuccessClosing,
    closeAuthProgressPanel,
    requestAccountsSnapshotUpdate
  ]);

  const handleAccountRefreshJobUpdate = React.useCallback((job: AccountRefreshJob) => {
    const jobId = String(job?.id || '').trim();
    if (!jobId) return;
    const accountRef = getAccountRef(job);
    if (job.status === 'queued' || job.status === 'running') {
      trackAccountUsageRefresh(accountRef);
      return;
    }

    clearAccountUsageRefresh(accountRef);
    const completionKey = `${jobId}:${job.status}:${job.finishedAt || job.updatedAt || 0}`;
    if (completedRefreshJobKeysRef.current.has(completionKey)) return;
    completedRefreshJobKeysRef.current.add(completionKey);

    if (job.status === 'failed') {
      const errorText = String(job.error || '').trim();
      if (/account_not_found/i.test(errorText)) {
        stageAccountRemoval(job);
        message.warning('账号已不存在，已从列表移除');
        return;
      }
      message.error(errorText || '刷新账号状态失败');
    }
  }, [clearAccountUsageRefresh, stageAccountRemoval, trackAccountUsageRefresh]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    persistActiveProviderTab(activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts, hydrating }) => {
        accountsSnapshotRevisionRef.current += 1;
        clearLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY);
        applyAccountsSnapshot(snapshotAccounts, {
          preserveLiveFields: Boolean(hydrating)
        });
        setHydratingDetails(Boolean(hydrating));
        hasLoadedAccountsRef.current = true;
        setLoading(false);
      },
      onSnapshotRequested: () => {
        trackAccountsSnapshotRefresh();
      },
      onAccount: (account) => {
        cancelAccountRemoval(getAccountRef(account));
        clearAccountUsageRefresh(getAccountRef(account));
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onAccountRemoved: (event: AccountRemovedEvent) => {
        const accountRef = getAccountRef(event);
        clearAccountUsageRefresh(accountRef);
        clearModelAccountRefreshing(accountRef);
        forgetModelProbe(accountRef);
        stageAccountRemoval(event);
      },
      onHydrated: () => {
        setHydratingDetails(false);
        clearAccountsSnapshotRefresh();
      },
      onAuthJob: handleAuthJobUpdate,
      onAccountRefreshJob: handleAccountRefreshJobUpdate,
      onError: () => {
        if (accountsSnapshotFallbackTimerRef.current === null) {
          setHydratingDetails(false);
        }
      }
    });
    return () => {
      watcher.close();
    };
  }, [applyAccountsSnapshot, cancelAccountRemoval, clearAccountUsageRefresh, clearAccountsSnapshotRefresh, clearModelAccountRefreshing, forgetModelProbe, handleAccountRefreshJobUpdate, handleAuthJobUpdate, mergeSingleAccount, stageAccountRemoval, trackAccountsSnapshotRefresh]);

  useEffect(() => {
    return () => {
      accountsLoadRequestRef.current += 1;
      if (successAutoCloseTimerRef.current !== null) {
        window.clearTimeout(successAutoCloseTimerRef.current);
        successAutoCloseTimerRef.current = null;
      }
      Object.values(removingAccountTimersRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
      removingAccountTimersRef.current = {};
      Object.values(refreshingUsageFallbackTimersRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
      refreshingUsageFallbackTimersRef.current = {};
      if (accountsSnapshotFallbackTimerRef.current !== null) {
        window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
        accountsSnapshotFallbackTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!addJobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const job = await accountsAPI.getAddJob(addJobId);
        if (cancelled) return;
        handleAuthJobUpdate(job);
      } catch (_error) {
        if (!cancelled) {
          setAddJobId(null);
        }
      }
    };

    poll();
    const timer = setInterval(poll, AUTH_JOB_FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [addJobId, handleAuthJobUpdate]);

  useEffect(() => {
    if (!selectedProvider) {
      previousAddProviderRef.current = undefined;
      form.setFieldValue('authMode', undefined);
      return;
    }
    if (previousAddProviderRef.current === selectedProvider) return;
    previousAddProviderRef.current = selectedProvider;
    const availableOptions = getSupportedAuthOptions(selectedProvider);
    const firstActiveMode = availableOptions.find((opt) => !opt.disabled)?.value || availableOptions[0]?.value;
    form.setFieldValue('authMode', firstActiveMode);
  }, [form, selectedProvider]);

  const closeAuthProgress = async (forceCancel = false) => {
    if (authSuccessClosing) return;
    if (addJob && addJob.status === 'running') {
      if (!forceCancel) {
        Modal.confirm({
          title: '取消当前授权流程？',
          content: authFlowKind === 'reauth'
            ? `取消后会保留原账号 ${authSubjectLabel || '当前账号'}，稍后可再次发起重新认证。`
            : `取消后不会保留这次未完成的接入流程。`,
          okText: '取消授权',
          cancelText: '继续等待',
          okButtonProps: { danger: true },
          onOk: async () => {
            await closeAuthProgress(true);
          }
        });
        return;
      }

      try {
        await accountsAPI.cancelAddJob(addJob.id);
        message.success('已取消当前授权流程');
        await requestAccountsSnapshotUpdate({ failureMessage: '刷新账号列表失败' });
      } catch (error: any) {
        message.error(error?.response?.data?.message || '取消授权失败');
        return;
      }
    }

    closeAuthProgressPanel();
  };

  const openAuthProgressFromResult = React.useCallback((result: {
    jobId?: string;
    provider: Provider;
    accountRef: string;
    authMode: AccountAuthMode;
    authorizationUrl?: string;
    redirectUri?: string;
    callbackCaptureStatus?: string;
    callbackListeningUrl?: string;
    callbackCaptureError?: string;
    authProgressState?: string;
  }, flowKind: 'add' | 'reauth', subjectLabel = '') => {
    if (!result.jobId) return;
    if (successAutoCloseTimerRef.current !== null) {
      window.clearTimeout(successAutoCloseTimerRef.current);
      successAutoCloseTimerRef.current = null;
    }
    setAuthSuccessClosing(false);
    setAuthFlowKind(flowKind);
    setAuthSubjectLabel(subjectLabel || 'OAuth 授权');
    setAuthCallbackUrl('');
    setAuthCallbackSubmitting(false);
    setAddJob({
      id: result.jobId,
      provider: result.provider,
      accountRef: result.accountRef,
      authMode: result.authMode,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      exitCode: null,
      authorizationUrl: result.authorizationUrl,
      redirectUri: result.redirectUri,
      callbackCaptureStatus: result.callbackCaptureStatus,
      callbackListeningUrl: result.callbackListeningUrl,
      callbackCaptureError: result.callbackCaptureError,
      authProgressState: result.authProgressState,
      logs: ''
    });
    setAddJobId(result.jobId);
    setAuthProgressVisible(true);
  }, []);

  const openExistingAuthProgress = React.useCallback(async (
    jobId: string,
    fallbackMessage: string,
    flowKind: 'add' | 'reauth'
  ) => {
    const job = await accountsAPI.getAddJob(jobId);
    if (successAutoCloseTimerRef.current !== null) {
      window.clearTimeout(successAutoCloseTimerRef.current);
      successAutoCloseTimerRef.current = null;
    }
    setAuthSuccessClosing(false);
    setAuthFlowKind(flowKind);
    setAuthCallbackUrl('');
    setAuthCallbackSubmitting(false);
    setAddJob(job);
    setAddJobId(job.status === 'running' ? jobId : null);
    setAuthProgressVisible(true);
    message.warning(fallbackMessage);
  }, []);

  const handleSubmitBrowserCallback = async () => {
    if (!addJob || addJob.status !== 'running') return;
    const copy = getCallbackUiCopy();
    const callbackUrl = authCallbackUrl.trim();
    if (!callbackUrl) {
      message.warning(copy.emptyWarning);
      return;
    }
    setAuthCallbackSubmitting(true);
    try {
      const job = await accountsAPI.completeBrowserCallback(addJob.id, callbackUrl);
      setAddJob(job);
      setAuthCallbackUrl('');
      message.success(copy.submitSuccess);
    } catch (error: any) {
      if (error?.response?.data?.job) {
        setAddJob(error.response.data.job);
        if (error.response.data.job.status !== 'running') {
          setAddJobId(null);
        }
      }
      message.error(error?.response?.data?.message || '提交回调失败');
    } finally {
      setAuthCallbackSubmitting(false);
    }
  };

  const canSubmitBrowserCallback = React.useMemo(() => {
    if (!addJob || addJob.status !== 'running') return false;
    return Boolean(authCallbackUrl.trim());
  }, [addJob, authCallbackUrl]);

  const handleOpenAddAccountModal = React.useCallback(() => {
    setEditingAccount(null);
    // 弹窗内 provider 下拉默认跟随当前选中的 tab，仍可在弹窗里手动切换。
    form.setFieldsValue({
      provider: isSupportedAccountProvider(activeProvider) ? activeProvider : undefined
    });
    setModalVisible(true);
  }, [activeProvider, form]);

  const handleAdd = async (values: any) => {
    setSubmitting(true);
    let configPayload: any = undefined;
    if (values.authMode === 'api-key' || values.authMode === 'auth-token') {
      configPayload = {
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        credentialType: values.authMode
      };
    }
    const requestPayload = {
      provider: values.provider as SupportedAccountProvider,
      authMode: values.authMode as AccountAuthMode,
      config: configPayload
    };
    try {
      const result = await accountsAPI.add(requestPayload);

      setModalVisible(false);
      form.resetFields();

      if (result.jobId) {
        openAuthProgressFromResult(result, 'add', 'OAuth 授权');
        message.info('请完成 OAuth 授权');
      } else {
        message.success('添加账号成功');
        void requestAccountsSnapshotUpdate();
      }
    } catch (error: any) {
      const code = error?.response?.data?.code;
      const existingJobId = error?.response?.data?.jobId;
      if (code === 'oauth_job_already_running' && existingJobId) {
        try {
          const retry = await accountsAPI.add({
            ...requestPayload,
            replaceExisting: true
          });
          setModalVisible(false);
          form.resetFields();
          if (retry.jobId) {
            openAuthProgressFromResult(retry, 'add', 'OAuth 授权');
          }
          message.warning('检测到上一次未完成授权，已自动替换旧作业并重新开始');
          return;
        } catch (_retryError) {
          try {
            setModalVisible(false);
            await openExistingAuthProgress(
              existingJobId,
              '检测到当前仍有未完成授权，已为你打开当前进度',
              'add'
            );
            return;
          } catch (_innerError) {
            // fall through
          }
        }
      }
      message.error(error?.response?.data?.message || '添加账号失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReauth = async (record: Account) => {
    try {
      const result = await accountsAPI.reauth(record.provider, record.accountRef);
      openAuthProgressFromResult(result, 'reauth', getAccountPrimaryLabel(record));
      message.info(`请重新完成 ${getAccountPrimaryLabel(record)} 的授权`);
    } catch (error: any) {
      const code = error?.response?.data?.code;
      const existingJobId = error?.response?.data?.jobId;
      if (code === 'oauth_job_already_running' && existingJobId) {
        try {
          await openExistingAuthProgress(
            existingJobId,
            `检测到 ${getAccountPrimaryLabel(record)} 已有授权流程，已为你打开当前进度`,
            'reauth'
          );
          return;
        } catch (_innerError) {
          // fall through
        }
      }
      message.error(error?.response?.data?.message || '重新认证失败');
    }
  };

  const handleDelete = async (provider: string, accountRef: string) => {
    const key = getAccountRef({ accountRef });
    if (!key || deletingAccountRefsRef.current.has(key)) return;
    deletingAccountRefsRef.current.add(key);
    try {
      await accountsAPI.delete(provider, accountRef);
      stageAccountRemoval({ accountRef });
      message.success('删除账号成功');
    } catch (_error) {
      message.error('删除账号失败');
    } finally {
      deletingAccountRefsRef.current.delete(key);
    }
  };

  const handleReload = async () => {
    await requestAccountsSnapshotUpdate({
      announce: true,
      failureMessage: '重新加载失败'
    });
  };

  const handleToggleStatus = async (record: Account, checked: boolean) => {
    const accountRef = getAccountRef(record);
    const optimisticAccount: Account = {
      ...record,
      status: checked ? 'up' : 'down'
    };
    setUpdatingStatusAccountRefs((current) => ({
      ...current,
      [accountRef]: true
    }));
    setAccounts((current) => mergeSingleAccount(current, optimisticAccount));
    try {
      const nextAccount = await accountsAPI.updateStatus(record.provider, record.accountRef, checked ? 'up' : 'down');
      setAccounts((current) => mergeSingleAccount(current, nextAccount));
      message.success(`账号已${checked ? '启用' : '关闭'}`);
    } catch (error: any) {
      setAccounts((current) => mergeSingleAccount(current, record));
      message.error(error?.response?.data?.message || '更新账号状态失败');
    } finally {
      setUpdatingStatusAccountRefs((current) => {
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
    }
  };

  const handleSetDefault = async (record: Account) => {
    const isClearing = Boolean(record.isDefault);
    try {
      if (isClearing) {
        await accountsAPI.clearDefault(record.provider, record.accountRef);
      } else {
        await accountsAPI.setDefault(record.provider, record.accountRef);
      }
      message.success(isClearing ? '默认账号已取消' : '默认账号已更新');
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      message.error(error?.response?.data?.message || (isClearing ? '取消默认账号失败' : '设置默认账号失败'));
    }
  };

  const handleRefreshUsage = async (record: Account) => {
    const accountRef = getAccountRef(record);
    trackAccountUsageRefresh(accountRef);
    try {
      const result = await accountsAPI.refreshUsage(record.provider, record.accountRef);
      if (result.job) {
        handleAccountRefreshJobUpdate(result.job);
      }
    } catch (error: any) {
      clearAccountUsageRefresh(accountRef);
      if (error?.response?.status === 404 || error?.response?.data?.error === 'account_not_found') {
        stageAccountRemoval(record);
        message.warning('账号已不存在，已从列表移除');
      } else {
        message.error(error?.response?.data?.message || '刷新账号状态失败');
      }
    }
  };

  const renderAuthDetail = (
    label: string,
    value: string,
    options: { copyMessage: string; openable?: boolean } = { copyMessage: '已复制' }
  ) => {
    const text = String(value || '').trim();
    if (!text) return null;
    return (
      <div className="auth-progress-detail-row">
        <Text strong className="auth-progress-detail-label">{label}</Text>
        <div className="auth-progress-detail-content">
          <Text className="auth-progress-detail-text">{text}</Text>
          <Space size={4} className="auth-progress-detail-actions">
            <Tooltip title="复制">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(text, options.copyMessage)}
              />
            </Tooltip>
            {options.openable ? (
              <Tooltip title="在当前浏览器打开">
                <Button
                  type="text"
                  size="small"
                  icon={<GlobalOutlined />}
                  onClick={() => openAuthLink(text)}
                />
              </Tooltip>
            ) : null}
          </Space>
        </div>
      </div>
    );
  };

  const getAuthJobIdentity = (job: AccountAddJob | null) => {
    const value = String(job?.email || job?.displayName || '').trim();
    if (value) return value;
    const subject = String(authSubjectLabel || '').trim();
    if (!subject || /授权|账号/.test(subject)) return '';
    return subject;
  };

  // 按 Provider 分组统计
  const providerStats = useMemo<ProviderStats>(() => {
    const stats = createProviderStats();

    accounts.forEach(account => {
      if (!isSupportedAccountProvider(account.provider)) return;
      const provider = account.provider;
      const providerBucket = stats[provider];
      const state = getAccountDisplayState(account);
      stats.all.total++;
      providerBucket.total++;

      if (state === 'healthy') {
        stats.all.healthy++;
        providerBucket.healthy++;
      } else if (state === 'exhausted') {
        stats.all.exhausted++;
        providerBucket.exhausted++;
      } else if (state === 'policy_blocked') {
        stats.all.policyBlocked++;
        providerBucket.policyBlocked++;
      } else if (state === 'usage_attention') {
        stats.all.usageAttention++;
        providerBucket.usageAttention++;
      } else if (state === 'runtime_blocked') {
        stats.all.runtimeBlocked++;
        providerBucket.runtimeBlocked++;
      } else if (state === 'disabled') {
        stats.all.disabled++;
        providerBucket.disabled++;
      } else if (state === 'unconfigured') {
        stats.all.unconfigured++;
        providerBucket.unconfigured++;
      }
    });

    return stats;
  }, [accounts]);

  // 过滤账号
  const filteredAccounts = useMemo(() => {
    let filtered = accounts.filter((account) => isSupportedAccountProvider(account.provider));

    // 按 provider 过滤
    if (activeProvider !== 'all') {
      filtered = filtered.filter(a => a.provider === activeProvider);
    }

    // 按状态过滤
    if (filterStatus !== 'all') {
      filtered = filtered.filter((account) => getAccountDisplayState(account) === filterStatus);
    }

    return filtered;
  }, [accounts, activeProvider, filterStatus]);

  useEffect(() => {
    if (!accountRouteTarget) return;
    // 从仪表盘错误跳入账号页时，确保目标账号不会被 provider/status 过滤掉。
    setActiveProvider(accountRouteTarget.provider);
    setFilterStatus('all');
  }, [accountRouteTarget]);

  useEffect(() => {
    if (!accountRouteTarget || loading) return;
    const row = document.querySelector<HTMLElement>(`[data-account-ref="${accountRouteTarget.accountRef}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [accountRouteTarget, filteredAccounts, loading]);

  // 账号操作菜单（⋮）—— 桌面表格列和移动卡片共用同一套 items + 点击分发，避免逻辑分叉。
  const buildAccountMenuItems = (record: Account): MenuProps['items'] => {
    const menuItems: MenuProps['items'] = [];
    menuItems.push({
      key: 'set-default',
      label: record.isDefault
        ? '取消默认账号'
        : (!record.configured ? '未配置账号不能设为默认账号' : '设为默认账号'),
      icon: record.isDefault ? <CheckCircleOutlined style={{ color: '#1677ff' }} /> : <CheckCircleOutlined />,
      disabled: Boolean(!record.isDefault && !record.configured)
    });
    if (canReauthAccount(record)) {
      menuItems.push({ key: 'reauth', label: getReauthActionLabel(record), icon: <SyncOutlined /> });
    }
    if (canEditAccountConfig(record)) {
      menuItems.push({ key: 'edit', label: '编辑配置', icon: <EditOutlined /> });
    }
    menuItems.push({
      key: 'export-account',
      label: (
        <span className="accounts-export-menu-item">
          <span>{exportingAccountRef === getAccountRef(record) ? '正在导出...' : '导出迁移 JSON'}</span>
          <small>不包含 AIH accountRef/id</small>
        </span>
      ),
      icon: <ExportOutlined />,
      disabled: Boolean(exportingAccountRef)
    });
    menuItems.push({ type: 'divider' });
    menuItems.push({ key: 'delete', label: '删除账号', danger: true, icon: <DeleteOutlined /> });
    return menuItems;
  };

  const handleAccountMenuClick = (record: Account, key: string) => {
    if (key === 'set-default') { handleSetDefault(record); return; }
    if (key === 'reauth') { handleReauth(record); return; }
    if (key === 'edit' && canEditAccountConfig(record)) { handleEdit(record); return; }
    if (key === 'export-account') { void handleExportAccount(record); return; }
    if (key === 'delete') {
      Modal.confirm({
        title: '确认删除？',
        content: `将删除 ${getAccountPrimaryLabel(record)}`,
        okText: '确认',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => handleDelete(record.provider, record.accountRef)
      });
    }
  };

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 280,
      render: (_text: any, record: Account) => (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ paddingTop: 3, flexShrink: 0 }}>
            <ProviderIcon provider={record.provider} size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24 }}>
              <div style={{ fontWeight: 600, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountPrimaryLabel(record)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {renderAccountRoleIcons(record)}
                {canCopyAccountEmail(record) ? (
                  <Tooltip title="复制账号">
                    <Button
                      className="copy-icon-btn"
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => copyAccountEmail(record)}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {getAccountSecondaryLabel(record) ? (
              <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountSecondaryLabel(record)}
              </div>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {renderAccountRoleTags(record)}
              <Tag color={getPlanTagColor(record)} style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', margin: 0 }}>
                {getPlanTagLabel(record)}
              </Tag>
            </div>
          </div>
        </div>
      )
    },
    {
      title: '开关',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      align: 'center' as const,
      render: (_status: any, record: Account) => {
        const accountRef = getAccountRef(record);
        const enabled = isAccountEnabled(record);
        return (
          <span style={{ display: 'inline-flex', justifyContent: 'center', width: 64 }}>
            <Switch
              checked={enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              loading={Boolean(updatingStatusAccountRefs[accountRef])}
              onChange={(checked) => handleToggleStatus(record, checked)}
            />
          </span>
        );
      }
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      key: 'configured',
      width: 120,
      align: 'center' as const,
      render: (configured: any) => (
        <Badge
          status={configured ? 'success' : 'default'}
          text={configured ? '已配置' : '未配置'}
        />
      )
    },
    {
      title: '调度状态',
      dataIndex: 'quotaStatus',
      key: 'quotaStatus',
      width: 180,
      render: (_quotaStatus: any, record: Account) => {
        const refreshable = canRefreshUsageAccount(record);
        const refreshingUsage = Boolean(refreshingUsageAccountRefs[getAccountRef(record)]);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderAccountDisplayBadge(record)}
            {refreshable ? (
              <Tooltip title="刷新当前账号状态">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={refreshingUsage}
                  onClick={() => handleRefreshUsage(record)}
                />
              </Tooltip>
            ) : null}
          </div>
        );
      }
    },
    {
      title: '模型探测',
      key: 'modelProbe',
      width: 180,
      render: (_value: any, record: Account) => {
        const probe = getAccountModelProbe(record, modelProbes);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="accounts-model-probe">
            <span
              className="accounts-model-probe-badge-link"
              role="button"
              tabIndex={0}
              onClick={() => { void openModelManagement(record); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void openModelManagement(record);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              <Badge
                status={getModelProbeTagColor(probe, modelRefreshing) as any}
                text={tagLabel}
              />
            </span>
            <Tooltip title="刷新该账号模型目录">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={modelRefreshing}
                onClick={() => refreshAccountModelCatalog(record)}
              />
            </Tooltip>
          </div>
        );
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 260,
      sorter: (a: Account, b: Account, sortOrder?: 'ascend' | 'descend' | null) => {
        const aKnown = hasKnownUsage(a);
        const bKnown = hasKnownUsage(b);
        if (aKnown !== bKnown) {
          const missingLastCompare = aKnown ? -1 : 1;
          return sortOrder === 'descend'
            ? -missingLastCompare
            : missingLastCompare;
        }
        const usageDiff = getUsageSortValue(a) - getUsageSortValue(b);
        if (usageDiff !== 0) return usageDiff;
        return String(getAccountRef(a)).localeCompare(String(getAccountRef(b)));
      },
      render: (_pct: any, record: Account) => (
        <UsageSnapshotCell record={record} />
      )
    },
    {
      title: 'Token 用量',
      dataIndex: 'tokenUsage',
      key: 'tokenUsage',
      width: 176,
      render: (_value: any, record: Account) => (
        <TokenUsageCell usage={record.tokenUsage} />
      )
    },
    {
      title: '额度更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: any) => {
        const t = formatTimeCell(timestamp);
        if (!t) return '-';
        return (
          <div>
            <div>{t.absolute}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>{t.relative}</div>
          </div>
        );
      }
    },
    {
      title: (
        <Tooltip title="仅统计经 aih server 成功转发的请求时间，不代表账号在其他客户端或本地 CLI 的全部使用记录。">
          <span>上次成功使用</span>
        </Tooltip>
      ),
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      width: 160,
      sorter: (a: Account, b: Account) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0),
      render: (timestamp?: any) => {
        const t = formatTimeCell(timestamp);
        if (!t) return '-';
        return (
          <div>
            <div>{t.absolute}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>{t.relative}</div>
          </div>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      align: 'center' as const,
      fixed: 'right' as const,
      render: (_: any, record: Account) => (
        <Dropdown
          menu={{
            items: buildAccountMenuItems(record),
            onClick: ({ key }: { key: string }) => handleAccountMenuClick(record, key)
          }}
          trigger={['click']}
        >
          <Button type="text" icon={<MoreOutlined />} />
        </Dropdown>
      )
    }
  ];

  // 移动端账号卡片 —— 把桌面宽表的一行数据竖排成一张卡（对齐 §2 表格→卡片列表）。
  // 复用桌面同款渲染 helper 和操作分发，逻辑不分叉；一切文本省略、不横向溢出。
  const renderAccountCard = (record: Account) => {
    const accountRef = getAccountRef(record);
    const enabled = isAccountEnabled(record);
    const probe = getAccountModelProbe(record, modelProbes);
    const modelRefreshing = Boolean(refreshingModelAccountRefs[getAccountRef(record)]);
    const lastUsed = formatTimeCell(record.lastUsedAt);
    return (
      <div className="mobile-card account-mobile-card" key={accountRef} data-account-ref={accountRef}>
        <div className="mobile-card-head">
          <span className="mobile-card-head-icon">
            <ProviderIcon provider={record.provider} size={22} />
          </span>
          <div className="mobile-card-head-main">
            <div className="mobile-card-title">
              <span className="mobile-card-title-text">{getAccountPrimaryLabel(record)}</span>
              {renderAccountRoleIcons(record)}
            </div>
            {getAccountSecondaryLabel(record) ? (
              <div className="mobile-card-subtitle">{getAccountSecondaryLabel(record)}</div>
            ) : null}
          </div>
          <div className="mobile-card-head-action">
            <button className="m-card-more" aria-label="更多操作" onClick={() => setActionAccount(record)}>
              <MoreOutlined />
            </button>
          </div>
        </div>

        {/* 状态 + 模型探测(轻量一行,可点探测进模型管理) */}
        <div className="account-mobile-meta">
          <span className="account-mobile-status">{renderAccountDisplayBadge(record)}</span>
            <span
              className="account-mobile-probe"
              role="button"
              tabIndex={0}
              onClick={() => { void openModelManagement(record); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void openModelManagement(record);
              }}
            >
            <Badge
              status={getModelProbeTagColor(probe, modelRefreshing) as any}
              text={getModelProbeTagLabel(probe, modelRefreshing)}
            />
          </span>
        </div>
        {/* 用量快照 */}
        <div className="account-mobile-usage">
          <UsageSnapshotCell record={record} />
        </div>
        <div className="account-mobile-token-usage">
          <div className="account-mobile-token-usage-head">
            <span>Token 用量</span>
          </div>
          <TokenUsageCell usage={record.tokenUsage} />
        </div>

        <div className="mobile-card-foot">
          <Switch
            checked={enabled}
            checkedChildren="启用"
            unCheckedChildren="关闭"
            loading={Boolean(updatingStatusAccountRefs[accountRef])}
            onChange={(checked) => handleToggleStatus(record, checked)}
          />
          <span className="mobile-card-foot-hint">
            {lastUsed ? `上次使用 ${lastUsed.relative}` : '尚无使用记录'}
          </span>
        </div>
      </div>
    );
  };

  const tabItems = [
    {
      key: 'all',
      label: <span style={{ padding: '0 8px' }}>全部 ({providerStats.all.total})</span>
    },
    ...PROVIDERS.map((provider) => ({
      key: provider,
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider={provider} size={14} /> {providerNames[provider]} ({providerStats[provider].total})
        </span>
      )
    }))
  ];
  const getAccountExitClassName = React.useCallback((record: Account) => (
    removingAccountRefs[getAccountRef(record)]
      ? 'accounts-row-exiting animate__animated animate__fadeOutLeft animate__faster'
      : ''
  ), [removingAccountRefs]);

  return (
    <PageScaffold ghost
      title="账号池管理"
      subTitle="统一管理 OAuth 和密钥账号；密钥账号的网络可达性以模型探测为准。"
      extra={isMobile ? (
        <div className="m-header-actions">
          <button className="m-icon-btn" aria-label="导入" disabled={importingAccounts} onClick={() => setImportModalVisible(true)}><ImportOutlined /></button>
          <button className="m-icon-btn primary" aria-label="添加账号" onClick={handleOpenAddAccountModal}><PlusOutlined /></button>
        </div>
      ) : (
        <>
          <Button
            key="import"
            icon={<ImportOutlined />}
            disabled={importingAccounts}
            onClick={() => setImportModalVisible(true)}
          >
            导入
          </Button>
          <Button
            key="add"
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenAddAccountModal}
          >
            添加账号
          </Button>
        </>
      )}
>
      {/* 顶部统计。移动端用专属 MobileStatGrid（2 列，数值不换行）；桌面保留 StatisticCard.Group。 */}
      {isMobile ? (
        /* 手机版只保留两张有信息量的卡:正常可用 / 耗尽·停用。
           「账号状态」恒为就绪、「待处理问题」常为 0,信息量低,已移除;
           每个账号卡自身已展示状态与用量。 */
        <MobileStatGrid
          items={[
            {
              key: 'healthy',
              label: '正常可用',
              value: `${providerStats[activeProvider].healthy} / ${providerStats[activeProvider].total}`
            },
            {
              key: 'exhausted',
              label: '耗尽/停用',
              value: providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked,
              hint: `耗尽 ${providerStats[activeProvider].exhausted} · 停池 ${providerStats[activeProvider].policyBlocked}`,
              valueColor: providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked > 0
                ? 'var(--color-danger, #dc2626)' : undefined
            }
          ]}
        />
      ) : (
        <StatisticCard.Group className="accounts-stat-group" direction="row" style={{ marginBottom: 16 }}>
          <StatisticCard
            statistic={{
              title: '账号状态',
              value: hydratingDetails ? '详情补全中' : '就绪',
              status: hydratingDetails ? 'processing' : 'success'
            }}
          />
          <StatisticCard
            statistic={{
              title: '正常可用',
              value: `${providerStats[activeProvider].healthy} / ${providerStats[activeProvider].total}`
            }}
          />
          <StatisticCard
            statistic={{
              title: '待处理问题',
              value: providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention,
              description: `阻塞 ${providerStats[activeProvider].runtimeBlocked} · 待校准 ${providerStats[activeProvider].usageAttention}`,
              valueStyle: {
                color: providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention > 0
                  ? 'var(--color-warning, #d97706)'
                  : undefined
              }
            }}
          />
          <StatisticCard
            statistic={{
              title: '耗尽/停用',
              value: providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked,
              description: `耗尽 ${providerStats[activeProvider].exhausted} · 停池 ${providerStats[activeProvider].policyBlocked}`,
              valueStyle: {
                color: providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked > 0
                  ? 'var(--color-danger, #dc2626)'
                  : undefined
              }
            }}
          />
        </StatisticCard.Group>
      )}

      <Modal
        title="导入账号"
        open={importModalVisible}
        onOk={handleImportSubmit}
        onCancel={closeImportModal}
        okText="导入"
        cancelText="取消"
        confirmLoading={importingAccounts}
        okButtonProps={{ disabled: !canSubmitImport }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Segmented
            value={importMode}
            onChange={handleImportModeChange}
            options={[
              { label: '文件', value: 'file' },
              { label: '粘贴', value: 'text' }
            ]}
          />
          {importMode === 'file' ? (
            <Alert
              type={importFileName ? 'success' : 'info'}
              showIcon
              message={importFileName ? `已选择 ${importFileName}` : '选择单份 sub2api JSON 文件'}
              description="只接受 type=sub2api-data 的文本 JSON；账号写入后由 Go 在后台异步刷新模型。"
              action={
                <Button size="small" onClick={() => importInputRef.current?.click()}>
                  {importFileName ? '重新选择' : '选择文件'}
                </Button>
              }
            />
          ) : null}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json,text/json"
            hidden
            onChange={handleImportFileChange}
          />
          {importMode === 'text' ? (
            <div className="accounts-import-paste">
              <Alert
                type="info"
                showIcon
                message="sub2api 迁移 JSON"
                description="只导入一份 sub2api-data JSON；AIH 内部 accountRef/id 不作为迁移身份。"
                action={
                  <Button size="small" onClick={() => setImportText(SUB2API_TEMPLATE)}>
                    填入模板
                  </Button>
                }
              />
              <div className="accounts-import-template">
                <div>格式模板</div>
                <pre>{SUB2API_TEMPLATE}</pre>
              </div>
              <Input.TextArea
                rows={8}
                placeholder="粘贴单份 sub2api-data JSON"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </div>
          ) : null}
        </div>
      </Modal>

        {isMobile ? (
          <div className="accounts-mobile-pool">
            <div className="m-filterbar">
              <button className="m-filter-btn" onClick={() => setAcctFilterOpen(true)}>
                <FilterOutlined />
                <span>筛选</span>
                <span className="m-filter-summary">
                  {(activeProvider === 'all' ? '全部' : providerNames[activeProvider as Provider]) || activeProvider}
                  {filterStatus !== 'all' ? ' · 已筛状态' : ''}
                </span>
              </button>
              <button className="m-icon-btn" onClick={handleReload} aria-label="刷新" disabled={refreshing}>
                <SyncOutlined spin={refreshing} />
              </button>
            </div>
            <Drawer
              title="筛选" placement="bottom" height="auto" open={acctFilterOpen}
              onClose={() => setAcctFilterOpen(false)} className="m-filter-drawer"
            >
              <div className="m-filter-group-label">来源</div>
              <MobilePills
                wrap
                items={tabItems.map((tab) => ({ key: tab.key, label: tab.label }))}
                activeKey={activeProvider}
                onChange={(key) => setActiveProvider(key as any)}
              />
              <div className="m-filter-group-label">状态</div>
              <MobilePills
                wrap
                items={[
                  { key: 'all', label: '全部状态' },
                  { key: 'healthy', label: '正常可用' },
                  { key: 'runtime_blocked', label: '运行阻塞' },
                  { key: 'usage_attention', label: '额度待确认' },
                  { key: 'policy_blocked', label: '已停池' },
                  { key: 'exhausted', label: '已耗尽' },
                  { key: 'disabled', label: '已关闭' },
                  { key: 'unconfigured', label: '未配置' }
                ]}
                activeKey={filterStatus}
                onChange={(key) => setFilterStatus(key as AccountFilterValue)}
              />
            </Drawer>
            {loading && filteredAccounts.length === 0 ? (
              <div style={{ padding: '48px 0', textAlign: 'center' }}><Spin /></div>
            ) : filteredAccounts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的账号" style={{ padding: '32px 0' }} />
            ) : (
              <div className="mobile-card-list">
                {filteredAccounts.map((record) => renderAccountCard(record))}
              </div>
            )}
            {/* 原生底部操作表(替代 PC 下拉菜单) */}
            <Drawer
              placement="bottom" height="auto" open={!!actionAccount} closable={false} title={null}
              onClose={() => setActionAccount(null)} className="m-action-sheet"
            >
              <div className="m-sheet-list">
                {actionAccount ? (buildAccountMenuItems(actionAccount) || []).map((item: any, i: number) => (
                  item?.type === 'divider' ? (
                    <div key={`d${i}`} className="m-sheet-divider" />
                  ) : (
                    <button
                      key={item.key}
                      className={`m-sheet-item${item.danger ? ' danger' : ''}`}
                      disabled={item.disabled}
                      onClick={() => { const a = actionAccount; setActionAccount(null); handleAccountMenuClick(a, item.key); }}
                    >
                      <span className="m-sheet-icon">{item.icon}</span>
                      <span className="m-sheet-label">{item.label}</span>
                    </button>
                  )
                )) : null}
                <button className="m-sheet-item cancel" onClick={() => setActionAccount(null)}>取消</button>
              </div>
            </Drawer>
          </div>
        ) : (
          <SectionCard title="当前账号池">
          <ListTable
            headerTitle={
              <Space size={12}>
                <Badge status="success" text={`可用 ${providerStats[activeProvider].healthy}`} />
                {providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention > 0 && (
                  <Badge status="warning" text={`待处理 ${providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention}`} />
                )}
                {providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked > 0 && (
                  <Badge status="error" text={`不可用 ${providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked}`} />
                )}
              </Space>
            }
            dataSource={filteredAccounts}
            columns={columns}
            rowKey={(record) => record.accountRef}
            rowClassName={(record) => [
              accountRouteTarget?.accountRef === getAccountRef(record) ? 'accounts-row-target' : '',
              getAccountExitClassName(record)
            ].filter(Boolean).join(' ')}
            onRow={(record) => ({
              'data-account-ref': getAccountRef(record)
            } as React.HTMLAttributes<HTMLElement>)}
            loading={loading}
            toolbar={{
              menu: {
                type: 'tab',
                activeKey: activeProvider,
                items: tabItems.map(tab => ({ key: tab.key, label: tab.label })),
                onChange: (key) => setActiveProvider(key as any)
              },
              actions: [
                <Select
                  key="status-filter"
                  value={filterStatus}
                  onChange={setFilterStatus}
                  style={{ width: 140 }}
                  options={[
                    { label: '全部状态', value: 'all' },
                    { label: '正常可用', value: 'healthy' },
                    { label: '运行阻塞', value: 'runtime_blocked' },
                    { label: '额度待确认', value: 'usage_attention' },
                    { label: '已停池', value: 'policy_blocked' },
                    { label: '已耗尽', value: 'exhausted' },
                    { label: '已关闭', value: 'disabled' },
                    { label: '未配置', value: 'unconfigured' }
                  ]}
                  suffixIcon={<FilterOutlined />}
                />,
                <Button
                  key="reload"
                  icon={<SyncOutlined />}
                  onClick={handleReload}
                  loading={refreshing}
                >
                  刷新
                </Button>
              ],
              settings: []
            }}
            scroll={{ x: 1200 }}
          />
          </SectionCard>
        )}

      <ModalForm
        title="编辑配置"
        open={editModalVisible}
        onOpenChange={(visible) => {
          if (!visible) {
            setEditModalVisible(false);
            editForm.resetFields();
          }
        }}
        form={editForm}
        layout="vertical"
        onFinish={async () => {
          return handleEditSubmit();
        }}
        submitter={{
          searchConfig: {
            submitText: '保存',
            resetText: '取消',
          },
        }}
      >
          {isEditingClaudeCredential ? (
            <Form.Item
              name="authMode"
              label="Claude 认证方式"
              rules={[{ required: true, message: '请选择 Claude 认证方式' }]}
            >
              <Radio.Group>
                <Space direction="vertical">
                  <Radio value="api-key">ANTHROPIC_API_KEY</Radio>
                  <Radio value="auth-token">ANTHROPIC_AUTH_TOKEN</Radio>
                </Space>
              </Radio.Group>
            </Form.Item>
          ) : null}
          <Form.Item
            name="apiKey"
            label={effectiveEditAuthMode === 'auth-token' ? 'Auth Token' : '密钥'}
            extra="保存会全量替换当前凭据；账号立即更新，模型目录在后台异步刷新。"
            rules={[{ required: true, message: '请重新输入完整凭据' }]}
          >
            <Input.Password autoComplete="new-password" placeholder="sk-..." />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="接口地址"
            extra="自定义反代或网关地址；留空表示恢复 Provider 官方地址。"
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
      </ModalForm>

      <Modal
        title="添加新账号"
        open={modalVisible}
        onOk={() => form.submit()}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
        }}
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleAdd}
        >
          <Form.Item
            name="provider"
            label="供应商"
            rules={[{ required: true, message: '请选择供应商' }]}
          >
            <Select placeholder="选择供应商" size="large">
              {PROVIDERS.map((provider) => (
                <Select.Option key={provider} value={provider}>
                  <Space align="center">
                    <ProviderIcon provider={provider} size={18} />
                    <span>{providerNames[provider]}</span>
                  </Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          {selectedProvider ? (
            <Form.Item
              name="authMode"
              label="认证方式"
              rules={[{ required: true, message: '请选择认证方式' }]}
            >
              <Radio.Group size="large">
                <Space direction="vertical">
                  {providerAuthOptions.map((option) => (
                    <Radio
                      key={option.value}
                      value={option.value}
                      disabled={Boolean(option.disabled)}
                    >
                      <Space direction="vertical" size={0}>
                        <Space align="center" size={6}>
                          <span>{option.label}</span>
                          {option.disabled && (
                            <Tag color="default" bordered={false} style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                              已停用
                            </Tag>
                          )}
                        </Space>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {option.disabledReason || option.description}
                        </Text>
                      </Space>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
          ) : null}

          {selectedAuthMode === 'api-key' || selectedAuthMode === 'auth-token' ? (
            <>
              <Form.Item
                name="apiKey"
                label={selectedAuthMode === 'auth-token' ? 'Auth Token' : '密钥'}
                rules={[{ required: true, message: '请输入密钥' }]}
              >
                <Input.Password autoComplete="new-password" placeholder="请输入密钥" size="large" />
              </Form.Item>

              <Form.Item
                name="baseUrl"
                label="接口地址（可选）"
                help="用于中转服务或自定义网关"
              >
                <Input placeholder="https://api.example.com" size="large" />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title="授权进度"
        open={authProgressVisible}
        wrapClassName="auth-progress-modal-wrap"
        footer={[
          <Button
            key="close"
            disabled={authSuccessClosing}
            onClick={() => closeAuthProgress(false)}
          >
            {authSuccessClosing
              ? '3 秒后自动关闭'
              : (addJob?.status === 'running' ? '关闭 / 取消' : '关闭')}
          </Button>
        ]}
        closable={!authSuccessClosing}
        keyboard={!authSuccessClosing}
        maskClosable={!authSuccessClosing}
        onCancel={() => closeAuthProgress(false)}
        width={760}
      >
        {addJob ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              type={
                addJob.status === 'failed'
                  ? 'error'
                  : addJob.status === 'succeeded'
                    ? 'success'
                    : addJob.status === 'expired'
                      ? 'warning'
                    : addJob.status === 'cancelled'
                      ? 'warning'
                      : 'info'
              }
              showIcon
              message={authSubjectLabel || 'OAuth 授权'}
              description={
                addJob.status === 'running'
                  ? '正在等待授权完成...'
                  : addJob.status === 'succeeded'
                    ? (authSuccessClosing ? '授权已完成，账号已经可用。弹窗将在 3 秒后自动关闭。' : '授权已完成，账号已经可用。')
                    : addJob.status === 'expired'
                      ? (addJob.error || '授权已过期，请重新发起。')
                    : addJob.status === 'cancelled'
                      ? (addJob.error || '授权流程已取消。')
                      : (addJob.error || '授权失败，请查看下方日志。')
              }
            />

            {Boolean(addJob.expiresAt || addJob.pollIntervalMs) && (
              <Card size="small" title="授权状态">
                {addJob.expiresAt ? (
                  <Paragraph>
                    <Text strong>过期时间：</Text> {dayjs(addJob.expiresAt).format('YYYY-MM-DD HH:mm:ss')}
                  </Paragraph>
                ) : null}
                {addJob.pollIntervalMs ? (
                  <Paragraph>
                    <Text strong>建议轮询间隔：</Text> {Math.round(addJob.pollIntervalMs / 1000)} 秒
                  </Paragraph>
                ) : null}
              </Card>
            )}

            {addJob.authMode === 'oauth-browser' && (
              <Card size="small" title="浏览器授权">
                {renderAuthDetail(
                  '邮箱',
                  getAuthJobIdentity(addJob),
                  { copyMessage: '已复制邮箱' }
                )}
                {renderAuthDetail(
                  '授权链接',
                  addJob.authorizationUrl || addJob.verificationUriComplete || addJob.verificationUri || '',
                  { copyMessage: '已复制授权链接', openable: true }
                )}
                {addJob.callbackCaptureStatus ? (
                  <Alert
                    style={{ marginBottom: 12 }}
                    type={addJob.callbackCaptureStatus === 'unavailable' ? 'warning' : 'info'}
                    showIcon
                    message={addJob.callbackCaptureStatus === 'unavailable'
                      ? '本地自动接收不可用'
                      : '本地自动接收已启动'}
                    description={addJob.callbackCaptureStatus === 'unavailable'
                      ? (addJob.callbackCaptureError || '请授权后把浏览器地址栏里的完整回调地址粘贴到下方。')
                      : (addJob.callbackListeningUrl || addJob.redirectUri || '等待浏览器授权回调。')}
                  />
                ) : null}
                {addJob.status === 'running' ? (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Text type="secondary">{getCallbackUiCopy().hint}</Text>
                    <Input.TextArea
                      value={authCallbackUrl}
                      onChange={(event) => setAuthCallbackUrl(event.target.value)}
                      placeholder={getCallbackUiCopy().placeholder}
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                    <Button
                      type="primary"
                      onClick={handleSubmitBrowserCallback}
                      loading={authCallbackSubmitting}
                      disabled={!canSubmitBrowserCallback}
                    >
                      {getCallbackUiCopy().submitLabel}
                    </Button>
                  </Space>
                ) : null}
              </Card>
            )}

            <Collapse
              size="small"
              items={[
                {
                  key: 'logs',
                  label: '授权日志',
                  children: (
                    <pre
                      style={{
                        margin: 0,
                        minHeight: 48,
                        maxHeight: 240,
                        padding: '8px 10px',
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 12,
                        lineHeight: 1.5,
                        background: 'var(--app-surface-muted)',
                        borderRadius: 6
                      }}
                    >
                      {String(addJob.logs || '').trimStart() || '等待供应商返回授权输出...'}
                    </pre>
                  )
                }
              ]}
            />
          </Space>
        ) : null}
      </Modal>

      <Drawer
        title={modelManagementAccount
          ? `${getAccountPrimaryLabel(modelManagementAccount)} · 模型管理`
          : '模型管理'}
        open={Boolean(modelManagementAccount)}
        onClose={closeModelManagement}
        width={560}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="模型策略只作用于当前账号"
            description="跟随上游使用已探测模型；强制启用/停用只修改该账号的模型关系，不会改变其他账号或上游目录。"
          />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text type="secondary">
              {modelManagementLoading ? '正在读取模型快照…' : `已保存 ${modelManagementModels.length} 个模型关系`}
            </Text>
            <Button
              icon={<ReloadOutlined />}
              loading={modelManagementLoading}
              onClick={() => { void refreshModelManagement(); }}
            >
              刷新目录
            </Button>
          </Space>
          {modelManagementLoading && modelManagementModels.length === 0 ? (
            <div style={{ padding: '36px 0', textAlign: 'center' }}><Spin /></div>
          ) : modelManagementModels.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚无已保存的模型关系；可先刷新目录"
            />
          ) : (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {modelManagementModels.map((model) => (
                <Card key={model.modelId} size="small" bodyStyle={{ padding: 12 }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space wrap size={[6, 6]}>
                      <Typography.Text strong>{model.modelId}</Typography.Text>
                      <Tag color={model.upstreamAvailable ? 'green' : 'default'}>
                        {model.upstreamAvailable ? '上游可用' : '上游未发现'}
                      </Tag>
                      <Tag color={model.effective ? 'blue' : 'default'}>
                        {model.effective ? '当前生效' : '未生效'}
                      </Tag>
                    </Space>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Text type="secondary">人工策略</Text>
                      <Select
                        value={model.manualPolicy}
                        options={MODEL_POLICY_OPTIONS}
                        style={{ minWidth: 132 }}
                        disabled={Boolean(modelPolicyUpdating)}
                        loading={modelPolicyUpdating === model.modelId}
                        onChange={(value) => {
                          void updateModelPolicy(model.modelId, value as AccountModelManualPolicy);
                        }}
                      />
                    </Space>
                  </Space>
                </Card>
              ))}
            </Space>
          )}
        </Space>
      </Drawer>
    </PageScaffold>
  );
};
