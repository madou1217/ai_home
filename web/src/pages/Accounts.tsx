import React, { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Radio,
  Segmented,
  Alert,
  message,
  Card,
  Tabs,
  Statistic,
  Row,
  Col,
  Dropdown,
  Typography,
  Grid,
  List,
  Empty,
  Tooltip,
  Collapse,
  Switch
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
  ImportOutlined
} from '@ant-design/icons';
import { accountsAPI, managementAPI } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  Provider
} from '@/types';
import ProviderIcon from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import {
  getAccountIdentityLabel,
  getAccountSecondaryIdentity,
  isInternalAccountLabel
} from '@/utils/account-labels';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

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
      label: 'OpenAI API Key',
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
      label: 'Anthropic API Key',
      description: '绑定 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。'
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
      label: 'Gemini API Key',
      description: '绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。'
    }
  ]
};

function getAccountPrimaryLabel(record: Account) {
  return getAccountIdentityLabel(record);
}

function getAccountSecondaryLabel(record: Account) {
  return getAccountSecondaryIdentity(record);
}

function getAccountMetaLabel(record: Pick<Account, 'apiKeyMode' | 'planType'>) {
  return `${record.apiKeyMode ? 'API Key' : 'OAuth'} · ${record.planType || 'free'}`;
}

function getAccountKey(record: Pick<Account, 'provider' | 'accountId'>) {
  return `${record.provider}-${record.accountId}`;
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

function getAccountDisplayState(record: Pick<Account, 'status' | 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus' | 'remainingPct' | 'provider' | 'usageSnapshot'>): AccountDisplayStateKind {
  if (!isAccountEnabled(record)) return 'disabled';
  if (!record.configured) return 'unconfigured';
  if (hasBlockingRuntimeStatus(record)) return 'runtime_blocked';
  if (String(record.quotaStatus || '').trim() === 'exhausted') return 'exhausted';
  if (String(record.schedulableStatus || '').trim() === 'blocked_by_policy') return 'policy_blocked';
  if (
    String(record.quotaStatus || '').trim()
    && !['available', 'not_applicable', 'exhausted'].includes(String(record.quotaStatus || '').trim())
  ) {
    return 'usage_attention';
  }
  if (!record.apiKeyMode && !hasKnownUsage(record)) return 'usage_attention';
  return 'healthy';
}

function canRefreshUsageAccount(record: Pick<Account, 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus'>) {
  if (!record.configured || record.apiKeyMode) return false;
  return hasBlockingRuntimeStatus(record)
    || Boolean(String(record.quotaStatus || '').trim())
    || String(record.schedulableStatus || '').trim() === 'blocked_by_policy';
}

function canReauthAccount(record: Pick<Account, 'configured' | 'apiKeyMode'>) {
  return Boolean(record.configured) && !Boolean(record.apiKeyMode);
}

function hasKnownUsageSnapshot(record: Pick<Account, 'provider' | 'usageSnapshot'>) {
  const snapshot = record.usageSnapshot;
  if (!snapshot) return false;
  if (record.provider === 'codex' && snapshot.kind === 'codex_oauth_status') {
    return (snapshot.entries || []).some((entry) => entry.remainingPct != null);
  }
  if (record.provider === 'gemini' && snapshot.kind === 'gemini_oauth_stats') {
    return (snapshot.models || []).some((model) => model.remainingPct != null);
  }
  return false;
}

function hasKnownUsage(record: Pick<Account, 'apiKeyMode' | 'remainingPct' | 'provider' | 'usageSnapshot'>) {
  if (record.apiKeyMode) return false;
  if (record.remainingPct != null) return true;
  return hasKnownUsageSnapshot(record);
}

function getUsageSortValue(record: Pick<Account, 'provider' | 'remainingPct' | 'usageSnapshot'>) {
  if (record.remainingPct != null) return Number(record.remainingPct);
  const snapshot = record.usageSnapshot;
  if (!snapshot) return -1;
  if (record.provider === 'codex' && snapshot.kind === 'codex_oauth_status') {
    const values = (snapshot.entries || [])
      .filter((entry) => entry.remainingPct != null)
      .filter((entry) => {
        const label = String(entry.window || '').trim().toLowerCase();
        return label === '5h' || label === '7days';
      })
      .map((entry) => Number(entry.remainingPct))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? Math.min(...values) : -1;
  }
  if (record.provider === 'gemini' && snapshot.kind === 'gemini_oauth_stats') {
    const values = (snapshot.models || [])
      .map((model) => Number(model.remainingPct))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? Math.min(...values) : -1;
  }
  return -1;
}

function formatQuotaReason(reason?: string) {
  const text = String(reason || '').trim();
  if (!text) return '';
  if (text === 'auth_metadata_only') {
    return '当前只有账号元信息，尚未采到真实额度快照。请刷新用量后再判断是否真的耗尽。';
  }
  if (text === 'codex_free_plan_missing_rate_limits') {
    return '当前账号的 token claim 已经是 free，但 Codex 没返回任何可计算的额度窗口。这更像账号已降级到 free，或 free 额度已经耗尽；建议直接重新登录确认。';
  }
  if (text === 'codex_team_plan_missing_rate_limits') {
    return '当前账号的 token claim 仍是 team，但 Codex 没返回任何可计算的额度窗口。这更像 team entitlement、workspace，或套餐状态异常；建议重新登录确认。';
  }
  if (text === 'provider_returned_no_numeric_usage') {
    return '已拿到 usage 快照，但上游没有返回可计算的 remaining 数值。';
  }
  if (text === 'timeout') return '额度查询超时。';
  if (text === 'probe_exception') return '额度查询过程中发生异常。';
  if (text === 'probe_failed') return '额度查询失败。';
  if (text === 'probe_not_ok') return '额度探测返回非成功结果。';
  if (text === 'empty_parsed_snapshot') return '上游返回了响应，但没有解析出可用额度。';
  if (text === 'direct_json_parse_failed') return '直连额度响应解析失败。';
  if (text === 'direct_missing_rate_limits') return '直连额度响应里缺少 rate limits。';
  if (text === 'direct_request_failed') return '直连额度请求失败。';
  if (text.startsWith('direct_http_status_')) {
    return `直连额度请求返回 ${text.replace('direct_http_status_', 'HTTP ')}。`;
  }
  if (text.startsWith('app_server_exit_')) {
    return `Codex app-server 退出：${text.replace('app_server_exit_', '')}。`;
  }
  if (text.startsWith('spawn_error:')) {
    return `额度探测进程启动失败：${text.replace('spawn_error:', '').trim()}`;
  }
  return text;
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
  return text;
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
  return (
    <Tag
      icon={<CheckCircleOutlined />}
      color="success"
    >
      正常
    </Tag>
  );
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
    merged.lastUsedAt = undefined;
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

const Accounts = () => {
  const { Paragraph, Text } = Typography;
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingStatusAccountKeys, setUpdatingStatusAccountKeys] = useState<Record<string, boolean>>({});
  const [refreshingUsageAccountKeys, setRefreshingUsageAccountKeys] = useState<Record<string, boolean>>({});
  const [hydratingDetails, setHydratingDetails] = useState(false);
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
  const [activeProvider, setActiveProvider] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importMode, setImportMode] = useState<'file' | 'path' | 'text'>('file');
  const [importPath, setImportPath] = useState('');
  const [importText, setImportText] = useState('');
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuthMode = (Form.useWatch('authMode', form) as AccountAuthMode | undefined) || 'oauth-browser';
  const providerAuthOptions = selectedProvider ? PROVIDER_AUTH_OPTIONS[selectedProvider] : [];

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

  const handleExport = async () => {
    try {
      await accountsAPI.export();
      message.success('导出成功');
    } catch { message.error('导出失败'); }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await accountsAPI.import({ content: text });
      message.success(`导入成功，共 ${result.imported} 个账号`);
      loadAccounts();
    } catch { message.error('导入失败，请检查文件格式'); }
    e.target.value = '';
  };

  const handleImportSubmit = async () => {
    try {
      const payload = importMode === 'path'
        ? { mode: 'path', path: importPath.trim() }
        : { content: importText };
      const result = await accountsAPI.import(payload);
      message.success(`导入成功，共 ${result.imported || 0} 个账号`);
      setImportModalVisible(false);
      setImportPath('');
      setImportText('');
      loadAccounts();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '导入失败');
    }
  };

  const loadAccounts = React.useCallback(async () => {
    if (hasLoadedOnce) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await accountsAPI.list();
      setAccounts((current) => mergeAccounts(current, payload.accounts, {
        preserveLiveFields: Boolean(payload.hydrating)
      }));
      setHydratingDetails(Boolean(payload.hydrating));
      setHasLoadedOnce(true);
    } catch (_error) {
      message.error('加载账号失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [hasLoadedOnce, mergeAccounts]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts, hydrating }) => {
        setAccounts((current) => mergeAccounts(current, snapshotAccounts, {
          preserveLiveFields: Boolean(hydrating)
        }));
        setHydratingDetails(Boolean(hydrating));
        setHasLoadedOnce(true);
        setLoading(false);
      },
      onAccount: (account) => {
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onHydrated: () => {
        setHydratingDetails(false);
      },
      onError: () => {
        setHydratingDetails(false);
      }
    });
    return () => {
      watcher.close();
    };
  }, [mergeAccounts, mergeSingleAccount]);

  useEffect(() => {
    return () => {
      if (successAutoCloseTimerRef.current !== null) {
        window.clearTimeout(successAutoCloseTimerRef.current);
        successAutoCloseTimerRef.current = null;
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
        setAddJob(job);
        if (job.status === 'succeeded') {
          const successLabel = getAuthJobIdentity(job) || authSubjectLabel || '账号';
          loadAccounts();
          setAddJobId(null);
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
        } else if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
          setAddJobId(null);
        }
      } catch (_error) {
        if (!cancelled) {
          setAddJobId(null);
        }
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [addJobId, authFlowKind, authSubjectLabel, authSuccessClosing, closeAuthProgressPanel, loadAccounts]);

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
        await loadAccounts();
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
    const callbackUrl = authCallbackUrl.trim();
    if (!callbackUrl) {
      message.warning('请粘贴回调地址');
      return;
    }
    setAuthCallbackSubmitting(true);
    try {
      const job = await accountsAPI.completeBrowserCallback(addJob.id, callbackUrl);
      setAddJob(job);
      setAuthCallbackUrl('');
      message.success('回调已提交，正在确认授权结果');
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

  const handleAdd = async (values: any) => {
    setSubmitting(true);
    const requestPayload = {
      provider: values.provider as Provider,
      authMode: values.authMode as AccountAuthMode,
      config: values.authMode === 'api-key'
        ? {
            apiKey: values.apiKey,
            baseUrl: values.baseUrl
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
        loadAccounts();
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
      message.success('删除账号成功');
      loadAccounts();
    } catch (_error) {
      message.error('删除账号失败');
    }
  };

  const handleReload = async () => {
    try {
      await managementAPI.reload();
      message.success('重新加载成功');
      loadAccounts();
    } catch (_error) {
      message.error('重新加载失败');
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

  const handleRefreshUsage = async (record: Account) => {
    const accountKey = getAccountKey(record);
    setRefreshingUsageAccountKeys((current) => ({
      ...current,
      [accountKey]: true
    }));
    try {
      const nextAccount = await accountsAPI.refreshUsage(record.provider, record.accountId);
      setAccounts((current) => mergeSingleAccount(current, nextAccount));
    } catch (error: any) {
      message.error(error?.response?.data?.message || '刷新账号状态失败');
    } finally {
      setRefreshingUsageAccountKeys((current) => {
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
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
  const providerStats = useMemo(() => {
    const stats: Record<string, {
      total: number;
      healthy: number;
      exhausted: number;
      policyBlocked: number;
      usageAttention: number;
      runtimeBlocked: number;
      disabled: number;
      unconfigured: number;
    }> = {
      all: { total: 0, healthy: 0, exhausted: 0, policyBlocked: 0, usageAttention: 0, runtimeBlocked: 0, disabled: 0, unconfigured: 0 },
      codex: { total: 0, healthy: 0, exhausted: 0, policyBlocked: 0, usageAttention: 0, runtimeBlocked: 0, disabled: 0, unconfigured: 0 },
      gemini: { total: 0, healthy: 0, exhausted: 0, policyBlocked: 0, usageAttention: 0, runtimeBlocked: 0, disabled: 0, unconfigured: 0 },
      claude: { total: 0, healthy: 0, exhausted: 0, policyBlocked: 0, usageAttention: 0, runtimeBlocked: 0, disabled: 0, unconfigured: 0 }
    };

    accounts.forEach(account => {
      const provider = account.provider;
      const state = getAccountDisplayState(account);
      stats.all.total++;
      stats[provider].total++;

      if (state === 'healthy') {
        stats.all.healthy++;
        stats[provider].healthy++;
      } else if (state === 'exhausted') {
        stats.all.exhausted++;
        stats[provider].exhausted++;
      } else if (state === 'policy_blocked') {
        stats.all.policyBlocked++;
        stats[provider].policyBlocked++;
      } else if (state === 'usage_attention') {
        stats.all.usageAttention++;
        stats[provider].usageAttention++;
      } else if (state === 'runtime_blocked') {
        stats.all.runtimeBlocked++;
        stats[provider].runtimeBlocked++;
      } else if (state === 'disabled') {
        stats.all.disabled++;
        stats[provider].disabled++;
      } else if (state === 'unconfigured') {
        stats.all.unconfigured++;
        stats[provider].unconfigured++;
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

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 250,
      render: (_text: string, record: Account) => (
        <div>
          <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ fontWeight: 'bold', minWidth: 0, flex: 1 }}>
              {getAccountPrimaryLabel(record)}
            </div>
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
            <Tag color={
              record.planType === 'team' ? 'blue' :
              record.planType === 'plus' ? 'green' :
              record.planType === 'business' ? 'gold' :
              record.planType === 'api-key' ? 'cyan' :
              'default'
            } style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>
              {record.planType || 'free'}
            </Tag>
            <span style={{ fontSize: 11, color: '#8c8c8c' }}>
              {record.apiKeyMode ? 'API Key' : 'OAuth'}
            </span>
          </Space>
        </div>
      )
    },
    {
      title: '认证类型',
      dataIndex: 'apiKeyMode',
      key: 'apiKeyMode',
      width: 100,
      render: (apiKeyMode: boolean) => (
        <Tag color={apiKeyMode ? 'blue' : 'green'}>
          {apiKeyMode ? 'API Key' : 'OAuth'}
        </Tag>
      )
    },
    {
      title: '账号开关',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (_status: Account['status'], record: Account) => {
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
      render: (configured: boolean) => (
        <Tag
          icon={configured ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={configured ? 'success' : 'default'}
        >
          {configured ? '已配置' : '未配置'}
        </Tag>
      )
    },
    {
      title: '运行状态',
      dataIndex: 'quotaStatus',
      key: 'quotaStatus',
      width: 190,
      render: (_quotaStatus: string, record: Account) => {
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
      render: (_pct: number | null, record: Account) => (
        <UsageSnapshotCell record={record} />
      )
    },
    {
      title: '额度更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: number) => {
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
      render: (timestamp?: number | null) => {
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
        if (canReauthAccount(record)) {
          menuItems.push({
            key: 'reauth',
            label: '重新登录',
            icon: <SyncOutlined />
          });
        }
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
                onClick: ({ key }) => {
                  if (key === 'reauth') {
                    handleReauth(record);
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
    {
      key: 'codex',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="codex" size={14} /> ChatGPT ({providerStats.codex.total})
        </span>
      )
    },
    {
      key: 'gemini',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="gemini" size={14} /> Gemini ({providerStats.gemini.total})
        </span>
      )
    },
    {
      key: 'claude',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="claude" size={14} /> Claude ({providerStats.claude.total})
        </span>
      )
    }
  ];

  const mobileAccounts = useMemo(() => {
    return accounts.filter((account) => getAccountDisplayState(account) === 'healthy');
  }, [accounts]);

  if (isMobile) {
    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>账号</h1>
            <Text type="secondary" style={{ fontSize: 14, lineHeight: 1.65 }}>
              {hydratingDetails ? '基础列表已显示，详情正在后台补全。' : '这里只保留可用账号，方便手机快速查看。'}
            </Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={loadAccounts} loading={refreshing}>
            刷新
          </Button>
        </div>

        <Card style={{ marginBottom: 12, borderRadius: 18 }}>
          <Statistic
            title="可用账号"
            value={mobileAccounts.length}
            prefix={<CheckCircleOutlined />}
            valueStyle={{ color: '#1677ff' }}
          />
          <Space wrap size={[8, 8]} style={{ marginTop: 12 }}>
            {(['codex', 'gemini', 'claude'] as Provider[]).map((provider) => (
              <Tag key={provider} color="blue">
                <Space size={4}>
                  <ProviderIcon provider={provider} size={12} />
                  {provider}
                  <span>{mobileAccounts.filter((account) => account.provider === provider).length}</span>
                </Space>
              </Tag>
            ))}
          </Space>
        </Card>

        <Card title="OK 列表" style={{ borderRadius: 18 }}>
          {mobileAccounts.length === 0 ? (
            <Empty description="暂无可用账号" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={mobileAccounts}
              renderItem={(record) => (
                <List.Item style={{ padding: '12px 0' }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <ProviderIcon provider={record.provider} size={16} />
                          <Text strong style={{ fontSize: 16, lineHeight: 1.45, flex: 1, minWidth: 0 }}>
                            {getAccountPrimaryLabel(record)}
                          </Text>
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
                          <div style={{ fontSize: 12, color: '#8c8c8c', lineHeight: 1.5, marginBottom: 4 }}>
                            {getAccountSecondaryLabel(record)}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 13, color: '#8c8c8c', lineHeight: 1.6 }}>
                          {getAccountMetaLabel(record)}
                        </div>
                        <div style={{ marginTop: 10, maxWidth: 220 }}>
                          <UsageSnapshotCell record={record} />
                        </div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        <Space size={6}>
                          {renderAccountDisplayTag(record)}
                          <Switch
                            size="small"
                            checked={isAccountEnabled(record)}
                            loading={Boolean(updatingStatusAccountKeys[getAccountKey(record)])}
                            onChange={(checked) => handleToggleStatus(record, checked)}
                          />
                          {canRefreshUsageAccount(record) ? (
                            <Tooltip title="刷新当前账号状态">
                              <Button
                                type="text"
                                size="small"
                                icon={<ReloadOutlined />}
                                loading={Boolean(refreshingUsageAccountKeys[getAccountKey(record)])}
                                onClick={() => handleRefreshUsage(record)}
                              />
                            </Tooltip>
                          ) : null}
                        </Space>
                      </div>
                    </div>
                  </div>
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
    );
  }

  return (
    <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0 }}>账号管理</h1>
            {hydratingDetails ? (
              <Text type="secondary">基础列表已返回，账号详情正在后台增量补全。</Text>
            ) : null}
          </div>
          <Space>
            <Button icon={<ExportOutlined />} onClick={handleExport}>导出</Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportModalVisible(true)}>导入</Button>
            <input ref={importInputRef} type="file" accept=".json,.jsonl" style={{ display: 'none' }} onChange={handleImport} />
            <Button icon={<ReloadOutlined />} onClick={loadAccounts} loading={refreshing}>刷新</Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.setFieldsValue({
                  provider: 'codex',
                  authMode: 'oauth-browser'
                });
                setModalVisible(true);
              }}
            >
              添加账号
            </Button>
          </Space>
        </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card>
            <Statistic
              title="总账号数"
              value={providerStats[activeProvider].total}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic
              title="正常可用"
              value={providerStats[activeProvider].healthy}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic
              title="运行阻塞"
              value={providerStats[activeProvider].runtimeBlocked}
              valueStyle={{ color: '#fa8c16' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic
              title="额度待确认"
              value={providerStats[activeProvider].usageAttention}
              valueStyle={{ color: '#d48806' }}
              prefix={<FilterOutlined />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic
              title="已停池"
              value={providerStats[activeProvider].policyBlocked}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic
              title="已耗尽"
              value={providerStats[activeProvider].exhausted}
              valueStyle={{
                color: providerStats[activeProvider].exhausted > 0 ? '#cf1322' : '#3f8600'
              }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="已关闭"
              value={providerStats[activeProvider].disabled}
              valueStyle={{ color: providerStats[activeProvider].disabled > 0 ? '#595959' : '#8c8c8c' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="未配置"
              value={providerStats[activeProvider].unconfigured}
              valueStyle={{ color: providerStats[activeProvider].unconfigured > 0 ? '#595959' : '#8c8c8c' }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card>
            <Statistic
              title="可用率"
              value={providerStats[activeProvider].total > 0
                ? Math.round((providerStats[activeProvider].healthy / providerStats[activeProvider].total) * 100)
                : 0
              }
              suffix="%"
              valueStyle={{
                color: providerStats[activeProvider].total > 0 &&
                  (providerStats[activeProvider].healthy / providerStats[activeProvider].total) > 0.5
                  ? '#3f8600' : '#cf1322'
              }}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        title="导入账号"
        open={importModalVisible}
        onOk={handleImportSubmit}
        onCancel={() => setImportModalVisible(false)}
        okText="导入"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Segmented
            value={importMode}
            onChange={(value) => setImportMode(value as 'file' | 'path' | 'text')}
            options={[
              { label: 'JSON 文件', value: 'file' },
              { label: '本地路径', value: 'path' },
              { label: '手动粘贴', value: 'text' }
            ]}
          />
          {importMode === 'file' ? (
            <Alert
              type="info"
              showIcon
              message="支持上传 JSON / JSONL。zip 或目录请改用“本地路径”方式。"
              action={<Button size="small" onClick={() => importInputRef.current?.click()}>选择文件</Button>}
            />
          ) : null}
          {importMode === 'path' ? (
            <Input
              placeholder="/absolute/path/to/folder-or-zip-or-json"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
          ) : null}
          {importMode === 'text' ? (
            <Input.TextArea
              rows={10}
              placeholder="粘贴单账号 JSON、bundle JSON，或多行 JSONL"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          ) : null}
        </div>
      </Modal>

      <Card>
        <Tabs
          activeKey={activeProvider}
          onChange={setActiveProvider}
          items={tabItems}
          tabBarExtraContent={
            <Space>
              <Select
                value={filterStatus}
                onChange={setFilterStatus}
                style={{ width: 150 }}
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
              />
              <Button
                icon={<SyncOutlined />}
                onClick={handleReload}
                loading={refreshing}
              >
                重新加载
              </Button>
            </Space>
          }
        />

        <Table
          dataSource={filteredAccounts}
          columns={columns}
          rowKey={(record) => `${record.provider}-${record.accountId}`}
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 个账号`,
            showSizeChanger: true,
            showQuickJumper: true
          }}
          scroll={{ x: 1200 }}
        />
      </Card>

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
            label="Provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select placeholder="选择 Provider" size="large">
              <Select.Option value="codex">
                <Space align="center">
                  <ProviderIcon provider="codex" size={18} />
                  <span>ChatGPT (OpenAI)</span>
                </Space>
              </Select.Option>
              <Select.Option value="gemini">
                <Space align="center">
                  <ProviderIcon provider="gemini" size={18} />
                  <span>Gemini (Google)</span>
                </Space>
              </Select.Option>
              <Select.Option value="claude">
                <Space align="center">
                  <ProviderIcon provider="claude" size={18} />
                  <span>Claude (Anthropic)</span>
                </Space>
              </Select.Option>
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

          {selectedAuthMode === 'api-key' ? (
            <>
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, message: '请输入 API Key' }]}
              >
                <Input.Password placeholder="请输入 API Key" size="large" />
              </Form.Item>

              {selectedProvider !== 'gemini' && (
                <Form.Item
                  name="baseUrl"
                  label="Base URL（可选）"
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

            {(addJob.expiresAt || addJob.pollIntervalMs) && (
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
                {addJob.status === 'running' ? (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Text type="secondary">
                      授权后如果浏览器停在回调页或显示无法连接，把地址栏完整地址粘贴到这里，服务器会校验 state 并换 token。
                    </Text>
                    <Input.TextArea
                      value={authCallbackUrl}
                      onChange={(event) => setAuthCallbackUrl(event.target.value)}
                      placeholder="粘贴完整回调地址，或只粘贴 ?code=...&state=..."
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                    <Button
                      type="primary"
                      onClick={handleSubmitBrowserCallback}
                      loading={authCallbackSubmitting}
                      disabled={!authCallbackUrl.trim()}
                    >
                      提交回调
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
                      {addJob.logs || '等待 Provider 返回授权输出...'}
                    </pre>
                  )
                }
              ]}
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  );
};

export default Accounts;
