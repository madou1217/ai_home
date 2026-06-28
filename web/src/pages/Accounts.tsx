import React, { useState, useEffect, useMemo } from 'react';
import { PageContainer, ProTable, ModalForm } from '@ant-design/pro-components';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Space,
  Tag,
  Modal,
  Descriptions,
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
  Popover,
  Typography,
  Menu
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  GlobalOutlined,
  ReloadOutlined,
  FilterOutlined,
  MoreOutlined,
  SyncOutlined,
  ExportOutlined,
  ImportOutlined,
  MobileOutlined,
  EditOutlined
} from '@ant-design/icons';
import { accountsAPI, modelsAPI } from '@/services/api';
import type { AccountExportFormat } from '@/services/api';
import type { AccountImportUploadFile } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  AccountImportJob,
  AccountImportResponse,
  AccountRefreshJob,
  AccountRemovedEvent,
  Provider,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse,
  WebUiModelsResponse,
} from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import {
  getAccountIdentityLabel,
  getAccountSecondaryIdentity,
  isInternalAccountLabel
} from '@/utils/account-labels';
import { formatAccountIssueReason } from '@/utils/account-reasons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import './Accounts.css';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const PROVIDERS: Provider[] = providerIds;
type ImportMode = 'file' | 'folder' | 'text' | 'cliproxyapi';
type PasteTemplate = 'sub2api' | 'antigravity' | 'jsonl';
const ACCOUNT_REMOVE_ANIMATION_MS = 420;
const AUTH_JOB_FALLBACK_POLL_MS = 5000;
const ACCOUNT_REFRESH_FALLBACK_CLEAR_MS = 70_000;
const ACCOUNT_SNAPSHOT_REFRESH_FALLBACK_MS = 70_000;

// Browser-OAuth wrap-up copy differs by provider, mirroring the backend login
// strategies: agy/claude keep a CLI running and want an authorization code
// pasted in, while codex/gemini redirect to a URL we forward. Centralizing the
// strings (and the "must wait for the code prompt" gate) keeps the modal free of
// scattered per-provider conditionals.
type CallbackUiCopy = {
  hint: string;
  placeholder: string;
  submitLabel: string;
  emptyWarning: string;
  submitSuccess: string;
  requiresAwaitingCode: boolean;
};

function getCallbackUiCopy(provider?: string): CallbackUiCopy {
  if (provider === 'agy') {
    return {
      hint: '授权后如果页面显示 authorization code，把完整授权码粘贴到这里，系统会写回 Antigravity CLI。',
      placeholder: '粘贴 Google 授权页返回的完整授权码',
      submitLabel: '提交授权码',
      emptyWarning: '请粘贴授权码',
      submitSuccess: '授权码已提交，正在确认授权结果',
      requiresAwaitingCode: true
    };
  }
  return {
    // codex / claude / gemini: aih (or the CLI) runs a localhost loopback server.
    // Same machine auto-captures; remote sessions paste the callback URL here.
    hint: '同一台机器会自动接收回调；如果是远端访问，浏览器停在回调页或显示无法连接时，把地址栏完整地址粘贴到这里。只有本次授权链接的 state 才会被接受。',
    placeholder: '粘贴完整回调地址，或只粘贴 ?code=...&state=...',
    submitLabel: '提交回调',
    emptyWarning: '请粘贴回调地址',
    submitSuccess: '回调已提交，正在确认授权结果',
    requiresAwaitingCode: false
  };
}

const EXPORT_ACTIONS: Array<{ format: AccountExportFormat; label: string; description: string }> = [
  {
    format: 'sub2api',
    label: '导出为迁移 JSON',
    description: '使用 sub2api-data 结构，不导出本地 accountId。'
  },
  {
    format: 'antigravity',
    label: '导出为 Antigravity Manager JSON',
    description: '导出 AGY OAuth 账号，适配 Antigravity Manager。'
  },
  {
    format: 'cliproxyapi',
    label: '导出为 CLIProxyAPI 数据',
    description: '下载 JSON 数据文件，不写入本机 CLIProxyAPI 配置。'
  }
];

const PASTE_TEMPLATES: Record<PasteTemplate, { label: string; description: string; value: string }> = {
  sub2api: {
    label: '迁移 JSON',
    description: '粘贴 sub2api-data JSON；本地账号 ID 会重新分配，冲突时按身份去重。',
    value: JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [],
      accounts: [
        {
          name: 'codex-main',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'user@example.com',
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            id_token: 'id-token',
            chatgpt_account_id: 'chatgpt-account-id'
          }
        }
      ]
    }, null, 2)
  },
  antigravity: {
    label: 'Antigravity Manager',
    description: '粘贴 Antigravity Manager JSON，账号会导入到 AGY provider。',
    value: JSON.stringify({
      accounts: [
        {
          email: 'user@example.com',
          refresh_token: 'agy-refresh-token'
        }
      ]
    }, null, 2)
  },
  jsonl: {
    label: 'JSONL / 单账号',
    description: '每行一个账号 JSON，适合手工合并多个来源。',
    value: [
      JSON.stringify({
        provider: 'codex',
        config: {
          OPENAI_API_KEY: 'sk-...',
          OPENAI_BASE_URL: 'https://api.openai.com/v1'
        }
      }),
      JSON.stringify({
        provider: 'gemini',
        auth: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          client_id: 'client-id',
          email: 'user@example.com'
        }
      })
    ].join('\n')
  }
};

const PROVIDER_AUTH_OPTIONS: Record<Provider, Array<{
  value: AccountAuthMode;
  label: string;
  description: string;
}>> = {
  codex: [
    {
      value: 'oauth-browser',
      label: 'ChatGPT / OpenAI 登录',
      description: '打开授权链接，授权后把回调地址提交给 WebUI。'
    },
    {
      value: 'oauth-device',
      label: '设备码登录',
      description: '仅在账号支持 device auth 时使用，适合远程环境。'
    },
    {
      value: 'api-key',
      label: 'OpenAI 密钥',
      description: '绑定 OPENAI_API_KEY / OPENAI_BASE_URL。'
    }
  ],
  claude: [
    {
      value: 'oauth-browser',
      label: 'Claude 登录',
      description: '使用 Claude Code 原生 login 流程（Claude.ai 凭据）。'
    },
    {
      value: 'api-key',
      label: 'Anthropic 密钥',
      description: '绑定 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。'
    },
    {
      value: 'auth-token',
      label: 'Claude Code Token',
      description: '绑定 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。'
    }
  ],
  gemini: [
    {
      value: 'oauth-browser',
      label: 'Google 登录',
      description: '使用 Gemini CLI 原生 Google 登录流程。'
    },
    {
      value: 'api-key',
      label: 'Gemini 密钥',
      description: '绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。'
    }
  ],
  agy: [
    {
      value: 'oauth-browser',
      label: 'Antigravity 登录',
      description: '使用 Antigravity CLI 原生 Google 登录流程。'
    }
  ],
  opencode: [
    {
      value: 'oauth-browser',
      label: 'OpenCode 登录',
      description: '使用 OpenCode CLI 原生 auth login 流程。'
    }
  ]
};


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

function getAccountKey(record: Pick<Account, 'provider' | 'accountId'>) {
  return `${record.provider}-${record.accountId}`;
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

function buildImportResponseFromJob(job: AccountImportJob): AccountImportResponse {
  return {
    ok: true,
    imported: Number(job.summary?.imported || 0),
    summary: job.summary,
    result: job.result
  };
}

function formatImportJobProgress(job: AccountImportJob | null) {
  if (!job) return '';
  const progress = job.progress;
  if (!progress) return job.status === 'queued' ? '等待后台导入开始' : '后台导入中';
  const percent = Number(progress.percent || 0);
  const label = String(progress.label || '').trim();
  return `${percent}%${label ? ` · ${label}` : ''}`;
}

function canCopyAccountEmail(record: Pick<Account, 'apiKeyMode' | 'email'>) {
  return !record.apiKeyMode && Boolean(String(record.email || '').trim());
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

type AccountProviderFilter = 'all' | Provider;

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
  const stats = {
    all: createProviderStatsBucket()
  } as ProviderStats;
  PROVIDERS.forEach((provider) => {
    stats[provider] = createProviderStatsBucket();
  });
  return stats;
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.includes(value as Provider);
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
  if (text === 'codex_free_plan_below_server_min_remaining') {
    return 'Free 账号剩余额度低于 20%，已从 aih server 账号池排除，避免接近上限时继续使用导致会话中断。';
  }
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

function renderPolicyBlockedTag(record: Pick<Account, 'schedulableReason'>) {
  const rawReason = String(record.schedulableReason || '').trim();
  if (!rawReason) return null;
  const reason = formatSchedulableReason(rawReason);
  const meta = (
    rawReason === 'codex_free_plan_below_server_min_remaining'
      ? { color: 'warning', label: 'Free <20% 停池' }
      : rawReason === 'codex_free_plan_missing_rate_limits'
        ? { color: 'warning', label: 'Free 待确认' }
        : rawReason === 'codex_team_plan_missing_rate_limits'
          ? { color: 'warning', label: 'Team 待确认' }
          : rawReason === 'agy_access_token_required'
            ? { color: 'warning', label: '需 Token' }
          : { color: 'warning', label: '已停池' }
  );
  const tag = <Tag color={meta.color}>{meta.label}</Tag>;
  if (!reason) return tag;
  return (
    <Tooltip title={reason}>
      {tag}
    </Tooltip>
  );
}

function renderQuotaStateTag(record: Pick<Account, 'quotaStatus' | 'quotaReason'>) {
  const status = String(record.quotaStatus || '').trim();
  if (!status) return null;
  const rawReason = String(record.quotaReason || '').trim();
  const reason = formatQuotaReason(record.quotaReason);
  const meta = (
    status === 'probe_failed' ? { color: 'error', label: '采集失败' }
      : status === 'provider_unavailable' && rawReason === 'codex_team_plan_missing_rate_limits'
        ? { color: 'warning', label: 'Team 待确认' }
        : status === 'provider_unavailable' && rawReason === 'codex_free_plan_missing_rate_limits'
          ? { color: 'warning', label: 'Free 待确认' }
        : status === 'provider_unavailable' ? { color: 'warning', label: '上游未返回' }
        : status === 'pending' ? { color: 'processing', label: '等待采集' }
          : { color: 'default', label: '额度未知' }
  );
  const tag = <Tag color={meta.color}>{meta.label}</Tag>;
  if (!reason) return tag;
  return (
    <Tooltip title={reason}>
      {tag}
    </Tooltip>
  );
}

function renderAccountDisplayTag(record: Account) {
  if (!record.configured && record.authPendingStale) return <Tag color="warning">授权超时</Tag>;
  const state = getAccountDisplayState(record);
  if (state === 'disabled') return <Tag color="default">已关闭</Tag>;
  if (state === 'unconfigured') return <Tag color="default">未配置</Tag>;
  if (state === 'runtime_blocked') {
    return (
      <RuntimeStatusTag
        status={record.runtimeStatus}
        reason={record.runtimeReason}
        until={record.runtimeUntil}
      />
    );
  }
  if (state === 'policy_blocked') {
    return renderPolicyBlockedTag(record) || <Tag color="warning">已停池</Tag>;
  }
  if (state === 'usage_attention') {
    return renderQuotaStateTag(record) || <Tag color="warning">额度待确认</Tag>;
  }
  if (state === 'exhausted') {
    return (
      <Tag
        icon={<CloseCircleOutlined />}
        color="error"
      >
        已耗尽
      </Tag>
    );
  }
  if (record.apiKeyMode) {
    return (
      <Tooltip title="密钥已配置且当前没有运行时阻塞；网络和模型接口可达性请看模型探测。">
        <Tag
          icon={<CheckCircleOutlined />}
          color="success"
        >
          可调度
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tag
      icon={<CheckCircleOutlined />}
      color="success"
    >
      正常
    </Tag>
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

function renderAccountRoleTags(record: Pick<Account, 'isDefault' | 'isMobile'>) {
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

function renderAccountRoleIcons(record: Pick<Account, 'isDefault' | 'isMobile'>) {
  if (!record.isDefault && !record.isMobile) return null;
  return (
    <Space size={4} style={{ flex: '0 0 auto' }}>
      {record.isDefault ? (
        <Tooltip title="当前默认账号">
          <span style={{ ...accountRoleIconStyle, color: '#1677ff', background: '#e6f4ff' }}>
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

function getPlanTagLabel(record: Pick<Account, 'apiKeyMode' | 'planType'>) {
  // 认证方式只展示一次，避免密钥模式在账号行里重复出现。
  if (record.apiKeyMode) return '密钥';
  return record.planType || 'free';
}

function getPlanTagColor(record: Pick<Account, 'apiKeyMode' | 'planType'>) {
  if (record.apiKeyMode) return 'cyan';
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

function getModelRefreshAccountRef(record: Pick<Account, 'accountRef'>) {
  return getAccountRef(record);
}

function getModelCatalogAccountScope(record: Pick<Account, 'accountRef'>) {
  const accountRef = getAccountRef(record);
  return {
    accountRef
  };
}

function getModelCatalogJobAccountRef(job: WebUiOpenAIModelsJob) {
  const scope = job.accountScope;
  if (!scope) return '';
  return String(scope.accountRef || '').trim();
}

function isModelCatalogJobActive(job: WebUiOpenAIModelsJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function buildAccountModelCatalogFromOpenAI(catalog: WebUiOpenAIModelsResponse | null): WebUiModelsResponse | null {
  if (!catalog) return null;
  return {
    ok: catalog.ok,
    cached: catalog.cached,
    updatedAt: catalog.updatedAt,
    source: catalog.source,
    sources: catalog.sources,
    scannedAccounts: catalog.scannedAccounts,
    firstError: catalog.firstError,
    models: catalog.byProvider || {},
    byAccount: {},
    byAccountRef: catalog.byAccountRef || {},
    errorsByAccount: {},
    errorsByAccountRef: catalog.errorsByAccountRef || {}
  };
}

function getAccountModelProbe(record: Account, catalog: WebUiModelsResponse | null) {
  const accountRef = getAccountRef(record);
  const byAccount = catalog?.byAccountRef || {};
  const errorsByAccount = catalog?.errorsByAccountRef || {};
  const hasModels = Boolean(accountRef && Object.prototype.hasOwnProperty.call(byAccount, accountRef));
  const hasError = Boolean(accountRef && Object.prototype.hasOwnProperty.call(errorsByAccount, accountRef));
  return {
    probed: Boolean(hasModels || hasError),
    models: hasModels && Array.isArray(byAccount[accountRef]) ? byAccount[accountRef] : [],
    error: String(hasError ? errorsByAccount[accountRef] : '')
  };
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
  if (probe.models.length > 0) return `模型 ${probe.models.length}`;
  if (probe.error) return formatModelProbeErrorLabel(probe.error);
  if (modelRefreshing) return '探测中';
  if (probe.probed) return '未发现模型';
  return '待探测';
}

function getModelProbeTagColor(probe: ReturnType<typeof getAccountModelProbe>, modelRefreshing: boolean) {
  if (probe.models.length > 0) return probe.error ? 'warning' : 'success';
  if (probe.error) return 'error';
  if (modelRefreshing) return 'processing';
  return probe.probed ? 'default' : 'default';
}

function mergeAccountRecord(
  current: Account,
  incoming: Account,
  options: { preserveLiveFields?: boolean } = {}
): Account {
  const fallbackDisplayName = `${incoming.provider}-${incoming.accountId}`;
  const merged: Account = {
    ...current,
    ...incoming
  };

  if (merged.apiKeyMode) {
    merged.runtimeStatus = undefined;
    merged.runtimeUntil = undefined;
    merged.runtimeReason = undefined;
    merged.usageSnapshot = null;
    merged.remainingPct = null as any;
    merged.quotaStatus = undefined;
    merged.quotaReason = undefined;
    merged.schedulableStatus = undefined;
    merged.schedulableReason = undefined;
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
  const location = useLocation();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [hydratingDetails, setHydratingDetails] = useState(false);
  const [removingAccountKeys, setRemovingAccountKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingStatusAccountKeys, setUpdatingStatusAccountKeys] = useState<Record<string, boolean>>({});
  const [refreshingUsageAccountKeys, setRefreshingUsageAccountKeys] = useState<Record<string, boolean>>({});
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
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
  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>('all');
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('file');
  const [pasteTemplate, setPasteTemplate] = useState<PasteTemplate>('sub2api');
  const [importText, setImportText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importFiles, setImportFiles] = useState<AccountImportUploadFile[]>([]);
  const [importingAccounts, setImportingAccounts] = useState(false);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importJob, setImportJob] = useState<AccountImportJob | null>(null);
  const [exportingAccounts, setExportingAccounts] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<WebUiModelsResponse | null>(null);
  const [refreshingModelAccountRefs, setRefreshingModelAccountRefs] = useState<Record<string, boolean>>({});
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const importFolderInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const removingAccountTimersRef = React.useRef<Record<string, number>>({});
  const completedImportJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedAuthJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedRefreshJobKeysRef = React.useRef<Set<string>>(new Set());
  const requestedModelCatalogJobIdsRef = React.useRef<Set<string>>(new Set());
  const refreshingUsageFallbackTimersRef = React.useRef<Record<string, number>>({});
  const accountsSnapshotFallbackTimerRef = React.useRef<number | null>(null);
  const accountsRef = React.useRef<Account[]>([]);
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuthMode = (Form.useWatch('authMode', form) as AccountAuthMode | undefined) || 'oauth-browser';
  const selectedEditAuthMode = Form.useWatch('authMode', editForm) as AccountAuthMode | undefined;
  const providerAuthOptions = selectedProvider ? PROVIDER_AUTH_OPTIONS[selectedProvider] : [];
  const editingClaudeCredentialMode = editingAccount?.provider === 'claude'
    ? getClaudeCredentialMode(editingAccount)
    : 'api-key';
  const effectiveEditAuthMode = selectedEditAuthMode || editingClaudeCredentialMode;
  const isEditingClaudeCredential = editingAccount?.provider === 'claude';
  const isEditCredentialModeChanged = Boolean(
    isEditingClaudeCredential && effectiveEditAuthMode !== editingClaudeCredentialMode
  );
  const accountRouteTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const provider = String(params.get('provider') || '').trim();
    const accountId = String(params.get('accountId') || '').trim();
    if (!isProvider(provider) || !accountId) return null;
    return {
      provider,
      accountId,
      key: `${provider}-${accountId}`
    };
  }, [location.search]);

  const copyAccountEmail = React.useCallback(async (record: Pick<Account, 'apiKeyMode' | 'email'>) => {
    const email = String(record.email || '').trim();
    if (!canCopyAccountEmail(record) || !email) return;
    try {
      await navigator.clipboard.writeText(email);
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

  const openAuthLink = React.useCallback((value?: string) => {
    const target = String(value || '').trim();
    if (!target) return;
    window.open(target, '_blank', 'noopener,noreferrer');
  }, []);

  const mergeAccounts = React.useCallback((
    current: Account[],
    incoming: Account[],
    options: { preserveLiveFields?: boolean } = {}
  ) => {
    const currentMap = new Map<string, Account>(
      current.map((account) => [getAccountKey(account), account])
    );
    const nextMap = new Map<string, Account>();
    incoming.forEach((account) => {
      const key = getAccountKey(account);
      const previous = currentMap.get(key);
      nextMap.set(key, previous ? mergeAccountRecord(previous, account, options) : account);
    });
    return Array.from(nextMap.values());
  }, []);

  const mergeSingleAccount = React.useCallback((current: Account[], incoming: Account) => {
    const next = current.slice();
    const key = getAccountKey(incoming);
    const index = next.findIndex((account) => getAccountKey(account) === key);
    if (index >= 0) {
      next[index] = mergeAccountRecord(next[index], incoming);
      return next;
    }
    next.push(incoming);
    return next;
  }, []);

  const clearAccountUsageRefresh = React.useCallback((accountKey: string) => {
    const key = String(accountKey || '').trim();
    if (!key) return;
    const timer = refreshingUsageFallbackTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete refreshingUsageFallbackTimersRef.current[key];
    }
    setRefreshingUsageAccountKeys((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const trackAccountUsageRefresh = React.useCallback((accountKey: string) => {
    const key = String(accountKey || '').trim();
    if (!key) return;
    setRefreshingUsageAccountKeys((current) => ({
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

  const cancelAccountRemoval = React.useCallback((accountKey: string) => {
    const key = String(accountKey || '').trim();
    if (!key) return;
    const timer = removingAccountTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete removingAccountTimersRef.current[key];
    }
    setRemovingAccountKeys((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const stageAccountRemoval = React.useCallback((target: Pick<Account, 'provider' | 'accountId'>) => {
    const accountKey = getAccountKey(target);
    if (!accountKey) return;
    clearAccountUsageRefresh(accountKey);
    setRemovingAccountKeys((current) => (
      current[accountKey] ? current : { ...current, [accountKey]: true }
    ));
    const currentTimer = removingAccountTimersRef.current[accountKey];
    if (currentTimer) window.clearTimeout(currentTimer);
    removingAccountTimersRef.current[accountKey] = window.setTimeout(() => {
      setAccounts((current) => current.filter((account) => getAccountKey(account) !== accountKey));
      setRemovingAccountKeys((current) => {
        if (!current[accountKey]) return current;
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
      setRefreshingUsageAccountKeys((current) => {
        if (!current[accountKey]) return current;
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
      setUpdatingStatusAccountKeys((current) => {
        if (!current[accountKey]) return current;
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
      delete removingAccountTimersRef.current[accountKey];
    }, ACCOUNT_REMOVE_ANIMATION_MS);
  }, [clearAccountUsageRefresh]);

  const applyAccountsSnapshot = React.useCallback((
    snapshotAccounts: Account[],
    options: { preserveLiveFields?: boolean } = {}
  ) => {
    const incoming = Array.isArray(snapshotAccounts) ? snapshotAccounts : [];
    const incomingKeys = new Set(incoming.map((account) => getAccountKey(account)));
    accountsRef.current
      .filter((account) => !incomingKeys.has(getAccountKey(account)))
      .forEach((account) => stageAccountRemoval(account));

    setAccounts((current) => {
      const next = mergeAccounts(current, incoming, options);
      const nextKeys = new Set(next.map((account) => getAccountKey(account)));
      const exiting = current.filter((account) => {
        const key = getAccountKey(account);
        return Boolean(removingAccountTimersRef.current[key]) && !nextKeys.has(key);
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

  const hasActiveImportJob = Boolean(importJobId);
  const canSubmitImport = !hasActiveImportJob && (importMode === 'cliproxyapi'
    ? true
    : importMode === 'text'
      ? Boolean(importText.trim())
      : importFiles.length > 0);

  const resetImportState = React.useCallback(() => {
    setImportText('');
    setImportFileName('');
    setImportFiles([]);
  }, []);

  const closeImportModal = React.useCallback(() => {
    if (importingAccounts) return;
    setImportModalVisible(false);
    resetImportState();
  }, [importingAccounts, resetImportState]);

  const handleExport = async (format: AccountExportFormat = 'sub2api') => {
    setExportingAccounts(true);
    try {
      await accountsAPI.export(format);
      message.success('导出成功');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '导出失败');
    } finally {
      setExportingAccounts(false);
    }
  };











  const handleImportModeChange = (value: string | number) => {
    const nextMode = value as ImportMode;
    setImportMode(nextMode);
    if (nextMode !== 'text') setImportText('');
    if (nextMode !== 'file' && nextMode !== 'folder') {
      setImportFileName('');
      setImportFiles([]);
    }
  };

  const handleImportSubmit = async () => {
    if (!canSubmitImport) {
      message.warning(importMode === 'text' ? '请粘贴导入内容' : '请选择导入文件');
      return;
    }
    setImportingAccounts(true);
    try {
      const payload = importMode === 'cliproxyapi'
        ? { mode: 'cliproxyapi' as const }
        : importMode === 'file' || importMode === 'folder'
          ? { mode: 'upload' as const, uploadKind: importMode, files: importFiles }
          : { content: importText };
      const result = await accountsAPI.import(payload);
      if (result.jobId) {
        setImportJobId(result.jobId);
        setImportJob(result.job || null);
        setImportModalVisible(false);
        resetImportState();
        message.info('导入任务已开始，账号会在后台写入');
        return;
      }
      const failedCount = Number(result.summary?.failed || 0) + Number(result.summary?.invalid || 0);
      const notify = Number(result.imported || 0) > 0 && failedCount === 0
        ? message.success
        : message.warning;
      notify(formatImportResult(result));
      setImportModalVisible(false);
      resetImportState();
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      const code = error?.response?.data?.error;
      const existingJobId = error?.response?.data?.jobId;
      if (code === 'import_job_already_running' && existingJobId) {
        setImportJobId(existingJobId);
        setImportJob(error.response.data.job || null);
        setImportModalVisible(false);
        resetImportState();
        message.warning('已有导入任务正在运行，已切换到当前导入进度');
        return;
      }
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

  const handleEditSubmit = async () => {
    try {
      const values = await editForm.validateFields();
      if (!editingAccount) return;
      setSubmitting(true);
      const res = await accountsAPI.updateAccount(editingAccount.provider, editingAccount.accountId, {
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
      }
    } catch (error: any) {
      if (error.errorFields) return;
      message.error(error.response?.data?.message || '更新失败');
    } finally {
      setSubmitting(false);
    }
  };

  const loadAccounts = React.useCallback(async () => {
    if (hasLoadedOnce) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await accountsAPI.list();
      applyAccountsSnapshot(payload.accounts, {
        preserveLiveFields: Boolean(payload.hydrating)
      });
      setHydratingDetails(Boolean(payload.hydrating));
      setHasLoadedOnce(true);
    } catch (_error) {
      message.error('加载账号失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyAccountsSnapshot, hasLoadedOnce]);

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

  const applyModelCatalogJob = React.useCallback((job: WebUiOpenAIModelsJob, options: { notify?: boolean } = {}) => {
    const accountRef = getModelCatalogJobAccountRef(job);
    const mappedCatalog = buildAccountModelCatalogFromOpenAI(job.catalog);

    if (mappedCatalog || (job.status === 'failed' && accountRef)) {
      setModelCatalog((prev) => {
        const baseCatalog: WebUiModelsResponse = prev || {
          ok: false,
          cached: false,
          updatedAt: Date.now(),
          source: '',
          sources: 0,
          scannedAccounts: 0,
          firstError: '',
          models: {},
          byAccount: {},
          byAccountRef: {},
          errorsByAccount: {},
          errorsByAccountRef: {},
          labels: {}
        };

        const nextModels = { ...baseCatalog.models };
        const nextByAccountRef = { ...baseCatalog.byAccountRef };
        const nextErrorsByAccountRef = { ...baseCatalog.errorsByAccountRef };
        const nextLabels = { ...baseCatalog.labels };

        if (mappedCatalog) {
          if (mappedCatalog.byAccountRef) {
            Object.entries(mappedCatalog.byAccountRef).forEach(([ref, models]) => {
              nextByAccountRef[ref] = models;
              delete nextErrorsByAccountRef[ref];
            });
          }
          if (mappedCatalog.errorsByAccountRef) {
            Object.entries(mappedCatalog.errorsByAccountRef).forEach(([ref, err]) => {
              nextErrorsByAccountRef[ref] = err;
              delete nextByAccountRef[ref];
            });
          }
          if (mappedCatalog.models) {
            Object.entries(mappedCatalog.models).forEach(([provider, models]) => {
              nextModels[provider] = models;
            });
          }
          if (mappedCatalog.labels) {
            Object.entries(mappedCatalog.labels).forEach(([provider, labels]) => {
              nextLabels[provider] = {
                ...(nextLabels[provider] || {}),
                ...labels
              };
            });
          }
        }

        if (accountRef) {
          if (job.status === 'failed') {
            nextErrorsByAccountRef[accountRef] = job.error || '探测失败';
            delete nextByAccountRef[accountRef];
          } else if (job.status === 'succeeded') {
            delete nextErrorsByAccountRef[accountRef];
          }
        }

        return {
          ...baseCatalog,
          ok: mappedCatalog ? mappedCatalog.ok : baseCatalog.ok,
          cached: mappedCatalog ? mappedCatalog.cached : baseCatalog.cached,
          updatedAt: mappedCatalog ? mappedCatalog.updatedAt : baseCatalog.updatedAt,
          source: mappedCatalog ? mappedCatalog.source : baseCatalog.source,
          sources: mappedCatalog ? mappedCatalog.sources : baseCatalog.sources,
          scannedAccounts: mappedCatalog ? mappedCatalog.scannedAccounts : baseCatalog.scannedAccounts,
          firstError: mappedCatalog ? mappedCatalog.firstError : baseCatalog.firstError,
          models: nextModels,
          byAccountRef: nextByAccountRef,
          errorsByAccountRef: nextErrorsByAccountRef,
          labels: nextLabels
        };
      });
    }

    if (accountRef) {
      if (isModelCatalogJobActive(job)) markModelAccountRefreshing(accountRef);
      else clearModelAccountRefreshing(accountRef);
    }

    if (!options.notify || !job.id || isModelCatalogJobActive(job)) return;
    if (!requestedModelCatalogJobIdsRef.current.has(job.id)) return;
    requestedModelCatalogJobIdsRef.current.delete(job.id);
    if (job.status === 'succeeded') {
      message.success('模型探测已刷新');
      return;
    }
    if (job.status === 'failed') {
      message.error(job.error || '模型探测失败');
    }
  }, [clearModelAccountRefreshing, markModelAccountRefreshing]);

  const loadModelCatalog = React.useCallback(async (options: { quiet?: boolean } = {}) => {
    // 模型探测独立于账号快照加载，避免账号页被网络探测阻塞。
    try {
      const catalog = await modelsAPI.listCatalog();
      setModelCatalog(catalog);
    } catch (error: any) {
      if (!options.quiet) {
        message.error(error?.response?.data?.message || error?.message || '读取模型缓存失败');
      }
    }
  }, []);

  const refreshAccountModelCatalog = React.useCallback(async (record: Account, options: { quiet?: boolean } = {}) => {
    const accountRef = getAccountRef(record);
    if (!accountRef) {
      message.error('账号缺少公开引用，请重新加载账号列表后再探测');
      return;
    }
    markModelAccountRefreshing(accountRef);
    let keepLiveLoading = false;
    try {
      const response = await modelsAPI.refreshOpenAICompatible(getModelCatalogAccountScope(record));
      if (response.job?.id) {
        if (!options.quiet) {
          requestedModelCatalogJobIdsRef.current.add(response.job.id);
        }
        keepLiveLoading = isModelCatalogJobActive(response.job);
        applyModelCatalogJob(response.job, { notify: false });
      }
      if (!options.quiet) {
        message.info(response.alreadyRunning ? '账号模型探测已在进行' : '账号模型探测已开始');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '账号模型探测失败');
    } finally {
      if (!keepLiveLoading) clearModelAccountRefreshing(accountRef);
    }
  }, [applyModelCatalogJob, clearModelAccountRefreshing, markModelAccountRefreshing]);

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

  const handleImportJobUpdate = React.useCallback((job: AccountImportJob) => {
    const jobId = String(job?.id || '').trim();
    if (!jobId) return;

    if (job.status === 'queued' || job.status === 'running') {
      setImportJobId(jobId);
      setImportJob(job);
      return;
    }

    const completionKey = `${jobId}:${job.status}:${job.finishedAt || job.updatedAt || 0}`;
    if (completedImportJobKeysRef.current.has(completionKey)) return;
    completedImportJobKeysRef.current.add(completionKey);
    setImportJobId((current) => (current === jobId ? null : current));
    setImportJob((current) => (current && current.id === jobId ? null : current));

    if (job.status === 'succeeded') {
      message.success(formatImportResult(buildImportResponseFromJob(job)));
      void requestAccountsSnapshotUpdate();
    } else if (job.status === 'failed') {
      message.error(job.error || '导入失败');
    }
  }, [requestAccountsSnapshotUpdate]);

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
    const accountKey = getAccountKey(job);
    if (job.status === 'queued' || job.status === 'running') {
      trackAccountUsageRefresh(accountKey);
      return;
    }

    clearAccountUsageRefresh(accountKey);
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
    loadAccounts();
  }, [loadAccounts]);

  const modelCatalogAccountRefsSignature = useMemo(() => {
    return accounts
      .map((account) => getAccountRef(account))
      .filter(Boolean)
      .sort()
      .join('|');
  }, [accounts]);

  useEffect(() => {
    loadModelCatalog({ quiet: true });
  }, [loadModelCatalog, modelCatalogAccountRefsSignature]);

  useEffect(() => {
    const watcher = modelsAPI.watchOpenAICompatibleRefresh({
      onSnapshot: (jobs) => {
        const sorted = [...jobs].sort((left, right) => {
          const leftAt = Number(left.finishedAt || left.startedAt || 0);
          const rightAt = Number(right.finishedAt || right.startedAt || 0);
          return rightAt - leftAt;
        });
        sorted.filter(isModelCatalogJobActive).forEach((job) => {
          applyModelCatalogJob(job, { notify: false });
        });
        const latest = sorted.find((job) => job.catalog) || sorted[0] || null;
        if (latest) applyModelCatalogJob(latest, { notify: false });
      },
      onJob: (job) => applyModelCatalogJob(job, { notify: true })
    });
    return () => watcher.close();
  }, [applyModelCatalogJob]);

  useEffect(() => {
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts, hydrating }) => {
        applyAccountsSnapshot(snapshotAccounts, {
          preserveLiveFields: Boolean(hydrating)
        });
        setHydratingDetails(Boolean(hydrating));
        setHasLoadedOnce(true);
        setLoading(false);
      },
      onSnapshotRequested: () => {
        trackAccountsSnapshotRefresh();
      },
      onAccount: (account) => {
        cancelAccountRemoval(getAccountKey(account));
        clearAccountUsageRefresh(getAccountKey(account));
        clearModelAccountRefreshing(getModelRefreshAccountRef(account));
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onAccountRemoved: (event: AccountRemovedEvent) => {
        clearAccountUsageRefresh(getAccountKey(event));
        const removedAccount = accountsRef.current.find((account) => (
          account.provider === event.provider && account.accountId === event.accountId
        ));
        clearModelAccountRefreshing(removedAccount ? getModelRefreshAccountRef(removedAccount) : '');
        stageAccountRemoval(event);
      },
      onHydrated: () => {
        setHydratingDetails(false);
        clearAccountsSnapshotRefresh();
      },
      onImportJob: handleImportJobUpdate,
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
  }, [applyAccountsSnapshot, cancelAccountRemoval, clearAccountUsageRefresh, clearAccountsSnapshotRefresh, clearModelAccountRefreshing, handleAccountRefreshJobUpdate, handleAuthJobUpdate, handleImportJobUpdate, mergeSingleAccount, stageAccountRemoval, trackAccountsSnapshotRefresh]);

  useEffect(() => {
    return () => {
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
    if (!selectedProvider) return;
    const allowedModes = PROVIDER_AUTH_OPTIONS[selectedProvider].map((item) => item.value);
    if (!allowedModes.includes(selectedAuthMode)) {
      form.setFieldValue('authMode', allowedModes[0]);
    }
  }, [form, selectedAuthMode, selectedProvider]);

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
    accountId: string;
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
    setAuthSubjectLabel(subjectLabel || (result.authMode === 'oauth-device' ? '设备码授权' : 'OAuth 授权'));
    setAuthCallbackUrl('');
    setAuthCallbackSubmitting(false);
    setAddJob({
      id: result.jobId,
      provider: result.provider,
      accountId: result.accountId,
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
    const copy = getCallbackUiCopy(addJob.provider);
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
    if (!authCallbackUrl.trim()) return false;
    if (!getCallbackUiCopy(addJob.provider).requiresAwaitingCode) return true;
    return addJob.authProgressState === 'awaiting_code';
  }, [addJob, authCallbackUrl]);

  const handleAdd = async (values: any) => {
    setSubmitting(true);
    const requestPayload = {
      provider: values.provider as Provider,
      authMode: values.authMode as AccountAuthMode,
      config: values.authMode === 'api-key' || values.authMode === 'auth-token'
        ? {
            apiKey: values.apiKey,
            baseUrl: values.baseUrl,
            credentialType: values.authMode
          }
        : undefined
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
      const result = await accountsAPI.reauth(record.provider, record.accountId);
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

  const handleDelete = async (provider: string, accountId: string) => {
    try {
      await accountsAPI.delete(provider, accountId);
      stageAccountRemoval({ provider: provider as Provider, accountId });
      message.success('删除账号成功');
    } catch (_error) {
      message.error('删除账号失败');
    }
  };

  const handleReload = async () => {
    const response = await requestAccountsSnapshotUpdate({
      announce: true,
      failureMessage: '重新加载失败'
    });
    if (response) {
      await loadModelCatalog({ quiet: true });
    }
  };

  const handleToggleStatus = async (record: Account, checked: boolean) => {
    const accountKey = getAccountKey(record);
    const optimisticAccount: Account = {
      ...record,
      status: checked ? 'up' : 'down'
    };
    setUpdatingStatusAccountKeys((current) => ({
      ...current,
      [accountKey]: true
    }));
    setAccounts((current) => mergeSingleAccount(current, optimisticAccount));
    try {
      const nextAccount = await accountsAPI.updateStatus(record.provider, record.accountId, checked ? 'up' : 'down');
      setAccounts((current) => mergeSingleAccount(current, nextAccount));
      message.success(`账号已${checked ? '启用' : '关闭'}`);
    } catch (error: any) {
      setAccounts((current) => mergeSingleAccount(current, record));
      message.error(error?.response?.data?.message || '更新账号状态失败');
    } finally {
      setUpdatingStatusAccountKeys((current) => {
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
    }
  };

  const handleSetDefault = async (record: Account) => {
    const isClearing = Boolean(record.isDefault);
    try {
      if (isClearing) {
        await accountsAPI.clearDefault(record.provider, record.accountId);
      } else {
        await accountsAPI.setDefault(record.provider, record.accountId);
      }
      message.success(isClearing ? '默认账号已取消' : '默认账号已更新');
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      message.error(error?.response?.data?.message || (isClearing ? '取消默认账号失败' : '设置默认账号失败'));
    }
  };

  const handleSetMobile = async (record: Account) => {
    const isClearing = Boolean(record.isMobile);
    try {
      if (isClearing) {
        await accountsAPI.clearMobile(record.provider, record.accountId);
      } else {
        await accountsAPI.setMobile(record.provider, record.accountId);
      }
      message.success(isClearing ? 'Codex App 账号已取消' : 'Codex App 账号已更新');
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      message.error(error?.response?.data?.message || (isClearing ? '取消 Codex App 账号失败' : '设置 Codex App 账号失败'));
    }
  };

  const handleRefreshUsage = async (record: Account) => {
    const accountKey = getAccountKey(record);
    trackAccountUsageRefresh(accountKey);
    try {
      const result = await accountsAPI.refreshUsage(record.provider, record.accountId);
      if (result.job) {
        handleAccountRefreshJobUpdate(result.job);
      }
    } catch (error: any) {
      clearAccountUsageRefresh(accountKey);
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
      const provider = account.provider;
      const providerBucket = stats[provider];
      if (!providerBucket) return;
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
    let filtered = accounts;

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
    const row = document.querySelector<HTMLElement>(`[data-account-key="${accountRouteTarget.key}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [accountRouteTarget, filteredAccounts, loading]);

  const openModelManagement = React.useCallback((record: Pick<Account, 'provider' | 'accountId' | 'accountRef'>) => {
    const provider = record.provider;
    const params = new URLSearchParams();
    const accountRef = getAccountRef(record);
    if (accountRef) params.set('accountRef', accountRef);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    navigate(`/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(record.accountId)}/models${suffix}`);
  }, [navigate]);

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 250,
      render: (_text: any, record: Account) => (
        <div>
          <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ fontWeight: 'bold', minWidth: 0, flex: 1 }}>
              {getAccountPrimaryLabel(record)}
            </div>
            {renderAccountRoleIcons(record)}
            {canCopyAccountEmail(record) ? (
              <Tooltip title="复制账号">
                <Button
                  className="account-email-copy-button"
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  style={{ color: '#bfbfbf' }}
                  onClick={() => copyAccountEmail(record)}
                />
              </Tooltip>
            ) : null}
          </div>
          {getAccountSecondaryLabel(record) ? (
            <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>
              {getAccountSecondaryLabel(record)}
            </div>
          ) : null}
          <Space size="small" align="center">
            <ProviderIcon provider={record.provider} size={14} />
            {renderAccountRoleTags(record)}
            <Tag color={getPlanTagColor(record)} style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>
              {getPlanTagLabel(record)}
            </Tag>
          </Space>
        </div>
      )
    },
    {
      title: '账号开关',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (_status: any, record: Account) => {
        const accountKey = getAccountKey(record);
        const enabled = isAccountEnabled(record);
        return (
          <Switch
            checked={enabled}
            checkedChildren="启用"
            unCheckedChildren="关闭"
            loading={Boolean(updatingStatusAccountKeys[accountKey])}
            onChange={(checked) => handleToggleStatus(record, checked)}
          />
        );
      }
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      key: 'configured',
      width: 100,
      render: (configured: any) => (
        <Tag
          icon={configured ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={configured ? 'success' : 'default'}
        >
          {configured ? '已配置' : '未配置'}
        </Tag>
      )
    },
    {
      title: '调度状态',
      dataIndex: 'quotaStatus',
      key: 'quotaStatus',
      width: 190,
      render: (_quotaStatus: any, record: Account) => {
        const refreshable = canRefreshUsageAccount(record);
        const refreshingUsage = Boolean(refreshingUsageAccountKeys[getAccountKey(record)]);
        return (
          <Space size={6}>
            {renderAccountDisplayTag(record)}
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
          </Space>
        );
      }
    },
    {
      title: '模型探测',
      key: 'modelProbe',
      width: 190,
      render: (_value: any, record: Account) => {
        const probe = getAccountModelProbe(record, modelCatalog);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing);
        return (
          <Space size={6} className="accounts-model-probe">
            <Tag
              className="accounts-model-probe-tag"
              role="button"
              tabIndex={0}
              color={getModelProbeTagColor(probe, modelRefreshing)}
              onClick={() => openModelManagement(record)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openModelManagement(record);
              }}
            >
              {tagLabel}
            </Tag>
            <Tooltip title="刷新该账号模型目录">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={modelRefreshing}
                onClick={() => refreshAccountModelCatalog(record)}
              />
            </Tooltip>
          </Space>
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
        return String(getAccountKey(a)).localeCompare(String(getAccountKey(b)));
      },
      render: (_pct: any, record: Account) => (
        <UsageSnapshotCell record={record} />
      )
    },
    {
      title: '额度更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: any) => {
        if (!timestamp) return '-';
        return (
          <div>
            <div>{dayjs(timestamp).format('MM-DD HH:mm')}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>{dayjs(timestamp).fromNow()}</div>
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
        if (!timestamp) return '-';
        return (
          <div>
            <div>{dayjs(timestamp).format('MM-DD HH:mm')}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>{dayjs(timestamp).fromNow()}</div>
          </div>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: any, record: Account) => {
        const menuItems: MenuProps['items'] = [];
        menuItems.push({
          key: 'set-default',
          label: record.isDefault
            ? '取消默认账号'
            : (!record.configured ? '未配置账号不能设为默认账号' : '设为默认账号'),
          icon: record.isDefault ? <CheckCircleOutlined style={{ color: '#1677ff' }} /> : <CheckCircleOutlined />,
          disabled: Boolean(!record.isDefault && !record.configured)
        });
        if (record.provider === 'codex') {
          menuItems.push({
            key: 'set-mobile',
            label: record.isMobile
              ? '取消 Codex App 账号'
              : (!record.configured
                  ? '未配置账号不能设为 Codex App 账号'
                  : (record.apiKeyMode ? '密钥账号不能设为 Codex App 账号' : '设为 Codex App 账号')),
            icon: record.isMobile ? <MobileOutlined style={{ color: '#722ed1' }} /> : <MobileOutlined />,
            disabled: Boolean(!record.isMobile && (!record.configured || record.apiKeyMode))
          });
        }
        if (canReauthAccount(record)) {
          menuItems.push({
            key: 'reauth',
            label: getReauthActionLabel(record),
            icon: <SyncOutlined />
          });
        }
        if (canEditAccountConfig(record)) {
          menuItems.push({
            key: 'edit',
            label: '编辑配置',
            icon: <EditOutlined />
          });
        }
        menuItems.push({ type: 'divider' });
        menuItems.push({
          key: 'delete',
          label: '删除账号',
          danger: true,
          icon: <DeleteOutlined />
        });

        return (
          <Space>
            <Dropdown
              menu={{
                items: menuItems,
                onClick: ({ key }: { key: string }) => {
                  if (key === 'set-default') {
                    handleSetDefault(record);
                    return;
                  }
                  if (key === 'set-mobile') {
                    handleSetMobile(record);
                    return;
                  }
                  if (key === 'reauth') {
                    handleReauth(record);
                    return;
                  }
                  if (key === 'edit' && canEditAccountConfig(record)) {
                    handleEdit(record);
                    return;
                  }
                  if (key === 'delete') {
                    Modal.confirm({
                      title: '确认删除？',
                      content: `将删除 ${getAccountPrimaryLabel(record)}`,
                      okText: '确认',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => handleDelete(record.provider, record.accountId)
                    });
                  }
                }
              }}
              trigger={['click']}
            >
              <Button icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
        );
      }
    }
  ];

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
  const activePasteTemplate = PASTE_TEMPLATES[pasteTemplate];
  const exportMenuItems: MenuProps['items'] = EXPORT_ACTIONS.map((action) => ({
    key: action.format,
    label: (
      <span className="accounts-export-menu-item">
        <span>{action.label}</span>
        <small>{action.description}</small>
      </span>
    )
  }));
  const exportMenuContent = (
    <Menu
      className="accounts-export-menu"
      items={exportMenuItems}
      selectable={false}
      onClick={({ key }) => {
        setExportMenuOpen(false);
        handleExport(key as AccountExportFormat);
      }}
    />
  );


  const getAccountExitClassName = React.useCallback((record: Account) => (
    removingAccountKeys[getAccountKey(record)]
      ? 'accounts-row-exiting animate__animated animate__fadeOutLeft animate__faster'
      : ''
  ), [removingAccountKeys]);

  return (
    <PageContainer
      header={{
        title: "账号池管理",
        subTitle: "统一管理 OAuth 和密钥账号；密钥账号的网络可达性以模型探测为准。",
        extra: [
          <Popover
            key="export"
            trigger="click"
            placement="bottomRight"
            arrow={false}
            open={exportMenuOpen}
            onOpenChange={setExportMenuOpen}
            content={exportMenuContent}
            overlayClassName="accounts-export-popover"
          >
            <Button
              icon={<ExportOutlined />}
              loading={exportingAccounts}
              disabled={exportingAccounts}
            >
              导出
            </Button>
          </Popover>,
          <Button
            key="import"
            icon={<ImportOutlined />}
            disabled={hasActiveImportJob}
            onClick={() => setImportModalVisible(true)}
          >
            导入
          </Button>,
          <Button
            key="add"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingAccount(null);
              setModalVisible(true);
            }}
          >
            添加账号
          </Button>
        ]
      }}
      content={(
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginTop: 8 }}>
          <Descriptions.Item label="账号状态">
              <Tag color={hydratingDetails ? "orange" : "green"}>{hydratingDetails ? "详情补全中" : "就绪"}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="正常可用">
            <span style={{ color: '#0F766E', fontWeight: 'bold' }}>{providerStats[activeProvider].healthy}</span> / {providerStats[activeProvider].total}
          </Descriptions.Item>
          <Descriptions.Item label="待处理问题">
            <span style={{ color: providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention > 0 ? '#fa8c16' : '#8c8c8c', fontWeight: 'bold' }}>
              {providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention}
            </span> (阻塞 {providerStats[activeProvider].runtimeBlocked} · 待校准 {providerStats[activeProvider].usageAttention})
          </Descriptions.Item>
          <Descriptions.Item label="耗尽/停用">
            <span style={{ color: providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked > 0 ? '#DC2626' : '#8c8c8c', fontWeight: 'bold' }}>
              {providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked}
            </span> (耗尽 {providerStats[activeProvider].exhausted} · 停池 {providerStats[activeProvider].policyBlocked})
          </Descriptions.Item>
        </Descriptions>
      )}
    >
      {hasActiveImportJob ? (
        <Alert
          type="info"
          showIcon
          message="账号导入正在后台运行"
          description={formatImportJobProgress(importJob)}
          style={{ marginBottom: 16 }}
        />
      ) : null}
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
              { label: '文件夹', value: 'folder' },
              { label: '粘贴', value: 'text' },
              { label: 'CLIProxyAPI', value: 'cliproxyapi' }
            ]}
          />
          {importMode === 'file' ? (
            <Alert
              type={importFileName ? 'success' : 'info'}
              showIcon
              message={importFileName ? `已选择 ${importFileName}` : '选择 JSON / JSONL / ZIP 文件'}
              description="支持迁移 JSON、Antigravity Manager、JSONL 和 zip 导入包。"
              action={
                <Button size="small" onClick={() => importInputRef.current?.click()}>
                  {importFileName ? '重新选择' : '选择文件'}
                </Button>
              }
            />
          ) : null}
          {importMode === 'folder' ? (
            <Alert
              type={importFileName ? 'success' : 'info'}
              showIcon
              message={importFileName ? `已选择 ${importFileName}` : '选择账号文件夹'}
              description="支持包含 provider 目录、账号目录、JSON 文件或嵌套 ZIP 的文件夹，上传后由统一导入器自动发现。"
              action={
                <Button size="small" onClick={() => importFolderInputRef.current?.click()}>
                  {importFileName ? '重新选择' : '选择文件夹'}
                </Button>
              }
            />
          ) : null}
          {importMode === 'text' ? (
            <div className="accounts-import-paste">
              <Select
                value={pasteTemplate}
                onChange={(value) => setPasteTemplate(value as PasteTemplate)}
                options={Object.entries(PASTE_TEMPLATES).map(([value, template]) => ({
                  value,
                  label: template.label
                }))}
              />
              <Alert
                type="info"
                showIcon
                message={activePasteTemplate.label}
                description={activePasteTemplate.description}
                action={
                  <Button size="small" onClick={() => setImportText(activePasteTemplate.value)}>
                    填入模板
                  </Button>
                }
              />
              <div className="accounts-import-template">
                <div>格式模板</div>
                <pre>{activePasteTemplate.value}</pre>
              </div>
              <Input.TextArea
                rows={8}
                placeholder="粘贴真实 JSON / JSONL 数据，或先填入模板再替换占位凭据"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </div>
          ) : null}
          {importMode === 'cliproxyapi' ? (
            <Alert
              type="info"
              showIcon
              message="从 CLIProxyAPI 配置导入"
              description="读取本机 CLIProxyAPI 配置和账号凭据，导入到 AI Home 账号池；无需上传文件。"
            />
          ) : null}
        </div>
      </Modal>

        <ProTable
          dataSource={filteredAccounts}
          columns={columns}
          rowKey={(record) => `${record.provider}-${record.accountId}`}
          rowClassName={(record) => [
            accountRouteTarget?.key === getAccountKey(record) ? 'accounts-row-target' : '',
            getAccountExitClassName(record)
          ].filter(Boolean).join(' ')}
          onRow={(record) => ({
            'data-account-key': getAccountKey(record)
          } as React.HTMLAttributes<HTMLElement>)}
          loading={loading}
          search={false}
          options={false}
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
          pagination={{
            pageSize: 15,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total) => `共 ${total} 个账号`
          }}
          scroll={{ x: 1200 }}
        />
      

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
        onFinish={async () => {
          await handleEditSubmit();
          return true;
        }}
        submitter={{
          searchConfig: {
            submitText: '保存',
            resetText: '取消',
          },
        }}
      >
        <Form form={editForm} layout="vertical" component={false}>
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
            extra={isEditCredentialModeChanged ? '切换认证方式时必须重新输入。' : '如不修改请留空。支持设置密钥以提升并发配额。'}
            rules={isEditCredentialModeChanged ? [{ required: true, message: '切换认证方式时请输入密钥' }] : []}
          >
            <Input.Password autoComplete="new-password" placeholder="sk-..." />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="接口地址"
            extra="自定义反代或网关地址。如不修改请留空。"
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
        </Form>
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

          <Form.Item
            name="authMode"
            label="认证方式"
            rules={[{ required: true, message: '请选择认证方式' }]}
          >
            <Radio.Group size="large">
              <Space direction="vertical">
                {providerAuthOptions.map((option) => (
                  <Radio key={option.value} value={option.value}>
                    <Space direction="vertical" size={0}>
                      <span>{option.label}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {option.description}
                      </Text>
                    </Space>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>

          {selectedAuthMode === 'api-key' || selectedAuthMode === 'auth-token' ? (
            <>
              <Form.Item
                name="apiKey"
                label={selectedAuthMode === 'auth-token' ? 'Auth Token' : '密钥'}
                rules={[{ required: true, message: '请输入密钥' }]}
              >
                <Input.Password autoComplete="new-password" placeholder="请输入密钥" size="large" />
              </Form.Item>

              {selectedProvider !== 'gemini' && (
                <Form.Item
                  name="baseUrl"
                  label="接口地址（可选）"
                  help="用于中转服务或自定义网关"
                >
                  <Input placeholder="https://api.example.com" size="large" />
                </Form.Item>
              )}
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
              message={authSubjectLabel || (addJob.authMode === 'oauth-device' ? '设备码授权' : 'OAuth 授权')}
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
                    <Text type="secondary">{getCallbackUiCopy(addJob.provider).hint}</Text>
                    <Input.TextArea
                      value={authCallbackUrl}
                      onChange={(event) => setAuthCallbackUrl(event.target.value)}
                      placeholder={getCallbackUiCopy(addJob.provider).placeholder}
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                    <Button
                      type="primary"
                      onClick={handleSubmitBrowserCallback}
                      loading={authCallbackSubmitting}
                      disabled={!canSubmitBrowserCallback}
                    >
                      {getCallbackUiCopy(addJob.provider).submitLabel}
                    </Button>
                  </Space>
                ) : null}
              </Card>
            )}

            {addJob.authMode === 'oauth-device' && (addJob.userCode || addJob.verificationUri || addJob.verificationUriComplete) && (
              <Card size="small" title="设备码信息">
                {renderAuthDetail('验证码', addJob.userCode || '', { copyMessage: '已复制验证码' })}
                {renderAuthDetail(
                  '授权链接',
                  addJob.verificationUriComplete || addJob.verificationUri || '',
                  { copyMessage: '已复制授权链接', openable: true }
                )}
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
                        maxHeight: 320,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 12,
                        lineHeight: 1.5
                      }}
                    >
                      {addJob.logs || '等待供应商返回授权输出...'}
                    </pre>
                  )
                }
              ]}
            />
          </Space>
        ) : null}
      </Modal>
    </PageContainer>
  );
};