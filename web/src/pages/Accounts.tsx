import './Accounts.css';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ModalForm, StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { useLocation, useNavigate } from 'react-router-dom';
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
  Popover,
  Typography,
  Menu,
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
  MobileOutlined,
  EditOutlined,
  CodeOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import {
  accountsAPI,
  modelsAPI,
  startAppInstallJob,
  waitForAppInstallJob
} from '@/services/api';
import {
  ACCOUNT_LIST_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage
} from '@/services/load-failure-message.js';
import { openExternalUrl } from '@/services/open-external-url';
import { formatTimeCell } from '@/utils/datetime';
import type { AccountExportFormat } from '@/services/api';
import type { AccountImportUploadFile } from '@/services/api';
import type { ZcodeCaptchaEvent } from '@/services/api';
import ZcodeCaptchaBridge from '@/components/account/ZcodeCaptchaBridge';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  AccountImportJob,
  AccountRefreshJob,
  AccountRemovedEvent,
  ClientTerminalItem,
  Provider,
  WebUiOpenAIModelsJob,
  WebUiModelsResponse,
} from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import { PROVIDER_AUTH_OPTIONS, PROVIDER_CATALOG } from '@/providers/catalog';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import TokenUsageCell from '@/components/account/TokenUsageCell';
import { isInternalAccountLabel } from '@/utils/account-labels';
import {
  canCopyAccountEmail,
  canEditAccountConfig,
  canReauthAccount,
  canRefreshUsageAccount,
  getAccountDisplayState,
  getClaudeCredentialMode,
  getReauthActionLabel,
  getUsageSortValue,
  hasKnownUsage,
  isAccountEnabled
} from '@/features/accounts/account-state';
import {
  buildAccountModelCatalogFromOpenAI,
  getAccountModelProbe,
  getAccountRef,
  getModelCatalogAccountScope,
  getModelCatalogJobAccountRef,
  getModelProbeTagColor,
  getModelProbeTagLabel,
  getModelRefreshAccountRef,
  isModelCatalogJobActive
} from '@/features/accounts/account-model-catalog';
import {
  EXPORT_ACTIONS,
  PASTE_TEMPLATES,
  buildImportResponseFromJob,
  formatImportJobProgress,
  formatImportResult
} from '@/features/accounts/account-import-export';
import type { ImportMode, PasteTemplate } from '@/features/accounts/account-import-export';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel,
  getPlanTagColor,
  getPlanTagLabel,
  renderAccountDisplayBadge,
  renderAccountRoleIcons,
  renderAccountRoleTags
} from '@/features/accounts/AccountBadges';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

// Provider 顺序和认证方式都来自 Go 核心生成的 Client 合同。
const PROVIDERS: readonly Provider[] = providerIds;
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

const ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY = 'accounts-active-provider-tab:v1';

function readStoredActiveProviderTab(): AccountProviderFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const saved = window.localStorage.getItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY);
    if (saved === 'all' || isProvider(saved || '')) return saved as AccountProviderFilter;
  } catch (_error) {
    // localStorage 不可用（隐私模式等）时静默回退到默认 tab。
  }
  return 'all';
}

function persistActiveProviderTab(provider: AccountProviderFilter): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCOUNTS_ACTIVE_PROVIDER_STORAGE_KEY, provider); } catch (_error) {}
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
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const location = useLocation();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [hydratingDetails, setHydratingDetails] = useState(false);
  const [zcodeCaptchaEvent, setZcodeCaptchaEvent] = useState<ZcodeCaptchaEvent | null>(null);
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
  const [cliInstallSubmitting, setCliInstallSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>(() => readStoredActiveProviderTab());
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [acctFilterOpen, setAcctFilterOpen] = useState(false);
  const [actionAccount, setActionAccount] = useState<Account | null>(null);
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
  const hasLoadedAccountsRef = React.useRef(false);
  const accountsSnapshotRevisionRef = React.useRef(0);
  const accountsLoadRequestRef = React.useRef(0);
  const previousAddProviderRef = React.useRef<Provider | undefined>(undefined);
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuthMode = Form.useWatch('authMode', form) as AccountAuthMode | undefined;
  const selectedEditAuthMode = Form.useWatch('authMode', editForm) as AccountAuthMode | undefined;
  const providerAuthOptions = selectedProvider
    ? (PROVIDER_AUTH_OPTIONS[selectedProvider] || [])
    : [];
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
    const accountRef = String(params.get('accountRef') || '').trim();
    if (!isProvider(provider) || !accountRef) return null;
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
          byAccountRef: {},
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

  // 桌面/CLI 入口按宿主机实测结果控制：加载完成前两个图标都隐藏，避免闪烁。
  // runningAccounts 记录桌面运行中的账号，用于给图标挂角标。
  const [appEntries, setAppEntries] = useState<Record<string, { desktop: boolean; cli: boolean }> | null>(null);
  const [appCapabilities, setAppCapabilities] = useState<Record<string, { desktop: boolean; cli: boolean }>>({});
  const [runningAccounts, setRunningAccounts] = useState<string[]>([]);
  const cliClickTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [cliPickerAccount, setCliPickerAccount] = useState<Account | null>(null);
  const [cliTerminals, setCliTerminals] = useState<ClientTerminalItem[]>([]);
  const [selectedCliTerminalId, setSelectedCliTerminalId] = useState('system-default');
  const [cliTerminalsLoading, setCliTerminalsLoading] = useState(false);
  useEffect(() => () => {
    Object.values(cliClickTimers.current).forEach((timer) => clearTimeout(timer));
  }, []);
  const loadAppEntries = async () => {
    try {
      const result = await accountsAPI.listAppEntries();
      setAppEntries(result.entries);
      setAppCapabilities(result.capabilities);
      setRunningAccounts(result.runningAccounts);
    } catch (_error) {
      setAppEntries((current) => current || {});
    }
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await accountsAPI.listAppEntries();
        if (cancelled) return;
        setAppEntries(result.entries);
        setAppCapabilities(result.capabilities);
        setRunningAccounts(result.runningAccounts);
      } catch (_error) {
        if (!cancelled) setAppEntries({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        clearModelAccountRefreshing(getModelRefreshAccountRef(account));
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onAccountRemoved: (event: AccountRemovedEvent) => {
        clearAccountUsageRefresh(getAccountRef(event));
        const removedAccount = accountsRef.current.find((account) => (
          account.provider === event.provider && account.accountRef === event.accountRef
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
      onZcodeCaptcha: (captchaEvent) => {
        setZcodeCaptchaEvent(captchaEvent);
      },
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
    const availableOptions = PROVIDER_AUTH_OPTIONS[selectedProvider] || [];
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
    setAuthSubjectLabel(subjectLabel || (result.authMode === 'oauth-device' ? '设备码授权' : 'OAuth 授权'));
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

  const handleConfirmCliInstall = async () => {
    if (!addJob?.id) return;
    setCliInstallSubmitting(true);
    try {
      const job = await accountsAPI.confirmCliInstall(addJob.id);
      setAddJob(job);
      message.info(`正在安装 ${providerNames[job.provider] || job.provider} CLI，完成后会自动继续授权。`);
    } catch (error: any) {
      message.error(error?.response?.data?.message || '启动 CLI 安装失败');
    } finally {
      setCliInstallSubmitting(false);
    }
  };

  const handleOpenAddAccountModal = React.useCallback(() => {
    setEditingAccount(null);
    // 弹窗内 provider 下拉默认跟随当前选中的 tab，仍可在弹窗里手动切换。
    form.setFieldsValue({ provider: isProvider(activeProvider) ? activeProvider : undefined });
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
    } else if (values.authMode === 'vertex-ai') {
      configPayload = {
        projectId: values.projectId,
        location: values.location,
        apiKey: values.apiKey
      };
    }
    const requestPayload = {
      provider: values.provider as Provider,
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
    try {
      await accountsAPI.delete(provider, accountRef);
      stageAccountRemoval({ accountRef });
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

  const handleSetMobile = async (record: Account) => {
    const isClearing = Boolean(record.isMobile);
    try {
      if (isClearing) {
        await accountsAPI.clearMobile(record.provider, record.accountRef);
      } else {
        await accountsAPI.setMobile(record.provider, record.accountRef);
      }
      message.success(isClearing ? 'Codex App 账号已取消' : 'Codex App 账号已更新');
      void requestAccountsSnapshotUpdate();
    } catch (error: any) {
      message.error(error?.response?.data?.message || (isClearing ? '取消 Codex App 账号失败' : '设置 Codex App 账号失败'));
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

  const handleOpenApp = async (record: Account, kind: 'desktop' | 'cli', terminalId?: string) => {
    try {
      const result = await accountsAPI.openApp(record.provider, record.accountRef, kind, 'open', terminalId);
      if (kind === 'desktop' && result.status === 'already_running') {
        Modal.confirm({
          title: '该账号的 Desktop 已在运行',
          content: '是否关闭它？',
          okText: '关闭',
          cancelText: '保留',
          onOk: async () => {
            try {
              await accountsAPI.openApp(record.provider, record.accountRef, 'desktop', 'close');
              message.success('已关闭');
              loadAppEntries();
            } catch (error: any) {
              message.error(error?.response?.data?.message || '关闭 Desktop 应用失败');
            }
          }
        });
        return;
      }
      message.success(kind === 'desktop' ? '已打开 Desktop 应用' : '已打开 CLI 终端');
      loadAppEntries();
    } catch (error: any) {
      const code = String(error?.response?.data?.error || '').trim();
      if (code === 'install_required') {
        if (error?.response?.data?.installAvailable === false) {
          message.info(error?.response?.data?.message || '请先手动安装目标应用后重试');
          return;
        }
        const runInstall = async () => {
          try {
            const job = await startAppInstallJob({
              provider: record.provider,
              kind,
              appId: kind === 'desktop' ? `${record.provider}-desktop` : record.provider
            });
            message.info('安装任务已提交，进度显示在右下角任务队列。');
            // 页面只负责等待后台任务完成后继续唤起目标应用；进度由全局 SSE
            // 任务队列呈现，刷新或切换页面不会中断服务端任务。
            const completed = await waitForAppInstallJob(job.id);
            if (completed.status !== 'succeeded') {
              throw new Error(completed.error || '安装未完成');
            }
            message.success('安装完成，正在打开应用…');
            await accountsAPI.openApp(record.provider, record.accountRef, kind, 'open', terminalId);
            loadAppEntries();
          } catch (installError: any) {
            message.error(installError?.response?.data?.message || installError?.message || '安装失败');
          }
        };
        Modal.confirm({
          title: `未检测到${kind === 'desktop' ? ' Desktop 应用' : '原生 CLI'}`,
          content: error?.response?.data?.message || '是否确认开始后台安装？',
          okText: '确认安装',
          cancelText: '取消',
          // 只确认并立即关闭弹窗；安装作业在 server 后台运行，进度经 SSE 回传。
          onOk: () => { void runInstall(); }
        });
        return;
      }
      if (code === 'account_unconfigured') {
        message.warning('账号尚未配置，完成授权或配置密钥后才能打开');
        return;
      }
      if (code === 'account_auth_invalid') {
        message.warning('账号认证已失效，请重新登录后再打开');
        return;
      }
      message.error(error?.response?.data?.message || (kind === 'desktop' ? '打开 Desktop 应用失败' : '打开 CLI 终端失败'));
    }
  };

  const chooseCliTerminal = async (record: Account) => {
    setCliTerminalsLoading(true);
    try {
      const response = await accountsAPI.listTerminals();
      const available = (response.terminals || []).filter((terminal) => terminal.installed);
      if (!available.length) {
        message.info('当前主机没有可用终端，请到 Toolkit > 终端管理安装。');
        return;
      }
      setCliTerminals(available);
      setSelectedCliTerminalId(available.find((terminal) => terminal.default)?.id || available[0].id);
      setCliPickerAccount(record);
    } catch (error: any) {
      message.error(error?.response?.data?.message || '读取可用终端失败');
    } finally {
      setCliTerminalsLoading(false);
    }
  };

  const scheduleCliTerminalPicker = (record: Account) => {
    const accountRef = getAccountRef(record);
    const existing = cliClickTimers.current[accountRef];
    if (existing) clearTimeout(existing);
    cliClickTimers.current[accountRef] = setTimeout(() => {
      delete cliClickTimers.current[accountRef];
      void chooseCliTerminal(record);
    }, 240);
  };

  const openCliWithDefaultTerminal = (record: Account) => {
    const accountRef = getAccountRef(record);
    const existing = cliClickTimers.current[accountRef];
    if (existing) {
      clearTimeout(existing);
      delete cliClickTimers.current[accountRef];
    }
    void handleOpenApp(record, 'cli', 'system-default');
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
    const row = document.querySelector<HTMLElement>(`[data-account-ref="${accountRouteTarget.accountRef}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [accountRouteTarget, filteredAccounts, loading]);

  const openModelManagement = React.useCallback((record: Pick<Account, 'provider' | 'accountRef'>) => {
    navigate(`/accounts/${encodeURIComponent(record.provider)}/${encodeURIComponent(record.accountRef)}/models`);
  }, [navigate]);

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
      menuItems.push({ key: 'reauth', label: getReauthActionLabel(record), icon: <SyncOutlined /> });
    }
    if (canEditAccountConfig(record)) {
      menuItems.push({ key: 'edit', label: '编辑配置', icon: <EditOutlined /> });
    }
    menuItems.push({ type: 'divider' });
    menuItems.push({ key: 'delete', label: '删除账号', danger: true, icon: <DeleteOutlined /> });
    return menuItems;
  };

  const handleAccountMenuClick = (record: Account, key: string) => {
    if (key === 'set-default') { handleSetDefault(record); return; }
    if (key === 'set-mobile') { handleSetMobile(record); return; }
    if (key === 'reauth') { handleReauth(record); return; }
    if (key === 'edit' && canEditAccountConfig(record)) { handleEdit(record); return; }
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
              {/* 操作按钮必须保持语义化图标（DesktopOutlined / CodeOutlined），禁止替换为 ProviderIcon，避免与行首厂商主图标混淆 */}
              {appEntries && (appEntries[record.provider]?.desktop || appCapabilities[record.provider]?.desktop) ? (
                <Tooltip title={!record.configured ? '账号未配置，完成授权后可打开 Desktop' : record.runtimeStatus === 'auth_invalid' ? '认证已失效，请重新登录' : runningAccounts.includes(getAccountRef(record)) ? 'Desktop 运行中（点击关闭）' : appEntries[record.provider]?.desktop ? '打开 Desktop' : '未安装 Desktop，点击后确认安装'}>
                  <Badge dot={runningAccounts.includes(getAccountRef(record))} status="success">
                    <Button
                      type="text"
                      size="small"
                      aria-label={`打开 ${providerNames[record.provider] || record.provider} Desktop`}
                      icon={<DesktopOutlined />}
                      disabled={!record.configured || record.runtimeStatus === 'auth_invalid'}
                      onClick={(event: any) => {
                        event?.stopPropagation?.();
                        handleOpenApp(record, 'desktop');
                      }}
                    />
                  </Badge>
                </Tooltip>
              ) : null}
              {appEntries
                && PROVIDER_CATALOG[record.provider as Provider]?.clients?.cli
                && (appEntries[record.provider]?.cli || appCapabilities[record.provider]?.cli) ? (
                <Tooltip title={!record.configured ? '账号未配置，完成授权后可打开 CLI' : record.runtimeStatus === 'auth_invalid' ? '认证已失效，请重新登录' : '单击选择终端，双击使用系统默认终端'}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={`打开 ${providerNames[record.provider] || record.provider} CLI`}
                    icon={<CodeOutlined />}
                    disabled={!record.configured || record.runtimeStatus === 'auth_invalid'}
                    onClick={(event: any) => {
                      event?.stopPropagation?.();
                      scheduleCliTerminalPicker(record);
                    }}
                    onDoubleClick={(event: any) => {
                      event?.stopPropagation?.();
                      openCliWithDefaultTerminal(record);
                    }}
                  />
                </Tooltip>
              ) : null}
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
        const probe = getAccountModelProbe(record, modelCatalog);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="accounts-model-probe">
            <span
              className="accounts-model-probe-badge-link"
              role="button"
              tabIndex={0}
              onClick={() => openModelManagement(record)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openModelManagement(record);
              }}
              style={{
                cursor: 'pointer',
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
      width: 214,
      // 单元格宽度随折叠变化，内容已居中；表头跟着居中才不会两头不齐。
      align: 'center' as const,
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
    const probe = getAccountModelProbe(record, modelCatalog);
    const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
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
            onClick={() => openModelManagement(record)}
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
          <Popover
            trigger="click" placement="bottomRight" arrow={false}
            open={exportMenuOpen} onOpenChange={setExportMenuOpen}
            content={exportMenuContent} overlayClassName="accounts-export-popover"
          >
            <button className="m-icon-btn" aria-label="导出" disabled={exportingAccounts}><ExportOutlined /></button>
          </Popover>
          <button className="m-icon-btn" aria-label="导入" disabled={hasActiveImportJob} onClick={() => setImportModalVisible(true)}><ImportOutlined /></button>
          <button className="m-icon-btn primary" aria-label="添加账号" onClick={handleOpenAddAccountModal}><PlusOutlined /></button>
        </div>
      ) : (
        <>
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
          </Popover>
          <Button
            key="import"
            icon={<ImportOutlined />}
            disabled={hasActiveImportJob}
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
                label={selectedAuthMode === 'auth-token' ? 'Auth Token' : (selectedProvider === 'gemini' ? 'Gemini API Key' : '密钥')}
                rules={[{ required: true, message: '请输入密钥' }]}
                help={selectedProvider === 'gemini' ? '填入 Google AI Studio 获取的 GEMINI_API_KEY 或 GOOGLE_API_KEY' : undefined}
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

          {selectedAuthMode === 'vertex-ai' ? (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="Vertex AI 占位模式"
                description="Google Cloud Vertex AI 认证暂未接入真实账号验证。提交后将创建占位账号记录，为后续接入打好基础。"
              />
              <Form.Item
                name="projectId"
                label="GCP Project ID"
                rules={[{ required: true, message: '请输入 Google Cloud Project ID' }]}
                initialValue="vertex-placeholder-project"
              >
                <Input placeholder="例如：my-gcp-project-123456" size="large" />
              </Form.Item>

              <Form.Item
                name="location"
                label="Region / Location"
                rules={[{ required: true, message: '请输入 Region / Location' }]}
                initialValue="us-central1"
              >
                <Input placeholder="例如：us-central1" size="large" />
              </Form.Item>

              <Form.Item
                name="apiKey"
                label="Service Account 凭据 / API Key（可选）"
                help="服务账号密钥 JSON 或 Vertex API Key（可选占位）"
              >
                <Input.Password autoComplete="new-password" placeholder="可选凭据" size="large" />
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

            {addJob.installRequired && addJob.setupPhase === 'awaiting-install-confirmation' ? (
              <Card size="small" title="需要安装 CLI">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text>检测到未安装 {providerNames[addJob.provider] || addJob.provider} CLI。</Text>
                  <Text type="secondary">确认后将在后台静默安装；安装成功会自动继续账号授权。</Text>
                  <Button type="primary" loading={cliInstallSubmitting} onClick={handleConfirmCliInstall}>
                    确认并安装
                  </Button>
                </Space>
              </Card>
            ) : null}

            {addJob.setupPhase === 'installing' ? (
              <Alert type="info" showIcon message="正在安装 CLI" description="安装输出会实时显示在下方日志中，成功后自动继续授权。" />
            ) : null}

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

            {addJob.authMode === 'oauth-browser' && !addJob.installRequired && (
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
      <Modal
        open={Boolean(cliPickerAccount)}
        title={cliPickerAccount ? `选择终端 · ${getAccountPrimaryLabel(cliPickerAccount)}` : '选择终端'}
        okText="打开 CLI"
        cancelText="取消"
        confirmLoading={cliTerminalsLoading}
        onCancel={() => setCliPickerAccount(null)}
        onOk={() => {
          if (!cliPickerAccount) return;
          const account = cliPickerAccount;
          setCliPickerAccount(null);
          void handleOpenApp(account, 'cli', selectedCliTerminalId);
        }}
      >
        <Select
          style={{ width: '100%' }}
          value={selectedCliTerminalId}
          onChange={setSelectedCliTerminalId}
          options={cliTerminals.map((terminal) => ({
            value: terminal.id,
            label: `${terminal.name}${terminal.default ? '（系统默认）' : ''}`,
            title: terminal.description
          }))}
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
          单击 CLI 图标选择终端；双击直接使用系统默认终端。ZCode 仅支持 Desktop，不提供 CLI/TUI。
        </Typography.Text>
      </Modal>
      <ZcodeCaptchaBridge event={zcodeCaptchaEvent} />
    </PageScaffold>
  );
};
