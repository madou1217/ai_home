import AccountCardGrid from '@/components/account/AccountCardGrid';
import './Accounts.css';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Space,
  Segmented,
  Tag,
  Badge,
  Modal,
  Form,
  Select,
  message,
  Dropdown,
  Tooltip,
  Switch,
  Popover,
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
  AppstoreOutlined,
  UnorderedListOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CopyOutlined,
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
  GlobalOutlined,
  QrcodeOutlined,
  UndoOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import {
  accountsAPI,
  managementAPI,
  toolkitAPI,
  waitForAppInstallJob
} from '@/services/api';
import { formatTimeCell } from '@/utils/datetime';
import type { AccountExportFormat } from '@/services/api';
import type { AccountImportUploadFile } from '@/services/api';
import type { TokenConsumedEvent } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  AccountImportJob,
  AppInstallJob,
  AccountRefreshJob,
  ClientTerminalItem,
  Provider,
} from '@/types';
import { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import { PROVIDER_AUTH_OPTIONS, PROVIDER_CATALOG } from '@/providers/catalog';
import TokenUsageCell from '@/components/account/TokenUsageCell';
import UsageProgressEffects from '@/features/accounts/UsageProgressEffects';
import AccountQuotaResetHistoryModal from '@/features/accounts/AccountQuotaResetHistoryModal';
import {
  appendLiveTokenEvent,
  useTokenDropEvents,
  type TokenDropEvent
} from '@/features/accounts/useTokenDropEvents';
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
  isAccountEnabled,
  mergeSingleAccount,
  reconcileAccountAfterReauthSuccess,
  requiresAccountReauth
} from '@/features/accounts/account-state';
import {
  getAccountModelProbe,
  getAccountRef,
  getModelProbeTagColor,
  getModelProbeTagLabel,
  getModelRefreshAccountRef
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
  useAccountsSnapshot
} from '@/features/accounts/useAccountsSnapshot';
import type { UseAccountsSnapshotHandlers } from '@/features/accounts/useAccountsSnapshot';
import {
  useModelCatalog
} from '@/features/accounts/useModelCatalog';
import { CliPickerModal } from '@/features/accounts/CliPickerModal';
import DirectoryPickerDialog from '@/features/legacy-chat/DirectoryPickerDialog';
import { useServerDirectoryPicker } from '@/features/legacy-chat/use-server-directory-picker';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { CodexResetCreditsModal } from '@/features/accounts/CodexResetCreditsModal';
import { AccountEgressModal } from '@/features/accounts/ZcodeEgressModal';
import {
  formatCodexResetMenuLabel,
  isCodexOAuthResetEligible
} from '@/features/accounts/codex-reset-credit-model';
import { AccountAppInstallModal } from '@/features/accounts/AccountAppInstallModal';
import { AccountAppInstallResultModal } from '@/features/accounts/AccountAppInstallResultModal';
import { EditAccountModal } from '@/features/accounts/EditAccountModal';
import { ImportAccountsModal } from '@/features/accounts/ImportAccountsModal';
import { AddAccountModal } from '@/features/accounts/AddAccountModal';
import {
  AuthProgressModal,
  getAuthJobIdentity,
  getCallbackUiCopy
} from '@/features/accounts/AuthProgressModal';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel,
  getPlanTagColor,
  getPlanTagLabel,
  renderAccountDisplayBadge,
  renderAccountRegionTag,
  renderAccountRoleIcons,
  renderAccountRoleTags
} from '@/features/accounts/AccountBadges';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import { startAccountAppEntryPolling } from '@/features/accounts/app-entry-poller';

// Provider 顺序和认证方式都来自 Go 核心生成的 Client 合同。
const PROVIDERS: readonly Provider[] = providerIds;
const AUTH_JOB_FALLBACK_POLL_MS = 5000;
const ACCOUNT_REFRESH_FALLBACK_CLEAR_MS = 70_000;

type AccountFilterValue =
  | 'all'
  | 'healthy'
  | 'reauth_required'
  | 'exhausted'
  | 'policy_blocked'
  | 'usage_attention'
  | 'runtime_blocked'
  | 'disabled'
  | 'unconfigured';

type AccountProviderFilter = 'all' | Provider;

type AccountAppInstallKind = 'desktop' | 'cli';

interface AccountAppInstallPrompt {
  record: Account;
  kind: AccountAppInstallKind;
  terminalId?: string;
  workdir?: string;
  message: string;
}

interface AccountAppInstallResult {
  prompt: AccountAppInstallPrompt;
  job: AppInstallJob | null;
  error?: string;
}

type ProviderStatsBucket = {
  total: number;
  healthy: number;
  exhausted: number;
  policyBlocked: number;
  reauthRequired: number;
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
    reauthRequired: 0,
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

const ACCOUNTS_VIEW_MODE_STORAGE_KEY = 'accounts-view-mode:v1';

function readStoredAccountsViewMode(): 'card' | 'list' {
  if (typeof window === 'undefined') return 'card';
  try {
    const saved = window.localStorage.getItem(ACCOUNTS_VIEW_MODE_STORAGE_KEY);
    if (saved === 'card' || saved === 'list') return saved;
  } catch (_error) {}
  return 'card';
}

function persistAccountsViewMode(mode: 'card' | 'list'): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCOUNTS_VIEW_MODE_STORAGE_KEY, mode); } catch (_error) {}
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

const CLI_WORKDIR_HISTORY_STORAGE_KEY = 'accounts-cli-workdir-history:v1';
const CLI_WORKDIR_HISTORY_LIMIT = 10;

function readCliWorkdirHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = window.localStorage.getItem(CLI_WORKDIR_HISTORY_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, CLI_WORKDIR_HISTORY_LIMIT);
  } catch (_error) {
    return [];
  }
}

function persistCliWorkdirHistory(history: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (history.length) window.localStorage.setItem(CLI_WORKDIR_HISTORY_STORAGE_KEY, JSON.stringify(history));
    else window.localStorage.removeItem(CLI_WORKDIR_HISTORY_STORAGE_KEY);
  } catch (_error) {}
}

export default function Accounts() {
  const [viewMode, setViewMode] = useState<'card' | 'list'>(readStoredAccountsViewMode);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const location = useLocation();
  const navigate = useNavigate();
  const accountsHandlersRef = React.useRef<UseAccountsSnapshotHandlers>({});
  const {
    accounts,
    setAccounts,
    hydratingDetails,
    removingAccountRefs,
    loading,
    refreshing,
    requestAccountsSnapshotUpdate,
    stageAccountRemoval
  } = useAccountsSnapshot(accountsHandlersRef);
  const [liveTokenDrops, setLiveTokenDrops] = useState<TokenDropEvent[]>([]);
  const tokenDrops = useTokenDropEvents(accounts, liveTokenDrops);
  const {
    modelCatalog,
    refreshingModelAccountRefs,
    refreshAccountModelCatalog,
    clearModelAccountRefreshing,
    loadModelCatalog
  } = useModelCatalog(accounts);
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
  const [accountAppInstallPrompt, setAccountAppInstallPrompt] = useState<AccountAppInstallPrompt | null>(null);
  const [accountAppInstallSubmitting, setAccountAppInstallSubmitting] = useState(false);
  const [accountAppInstallResult, setAccountAppInstallResult] = useState<AccountAppInstallResult | null>(null);
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
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const importFolderInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const completedImportJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedAuthJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedRefreshJobKeysRef = React.useRef<Set<string>>(new Set());
  const refreshingUsageFallbackTimersRef = React.useRef<Record<string, number>>({});
  const previousAddProviderRef = React.useRef<Provider | undefined>(undefined);
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedEditAuthMode = Form.useWatch('authMode', editForm) as AccountAuthMode | undefined;
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
      const successLabel = getAuthJobIdentity(job, authSubjectLabel) || authSubjectLabel || '账号';
      const isReauthSuccess = Boolean(job.reauth) || authFlowKind === 'reauth';
      if (isReauthSuccess) {
        setAccounts((current) => reconcileAccountAfterReauthSuccess(current, job.accountRef));
      }
      void requestAccountsSnapshotUpdate();
      if (!authSuccessClosing) {
        setAuthSuccessClosing(true);
        message.success(
          isReauthSuccess
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
    requestAccountsSnapshotUpdate,
    setAccounts
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
    persistActiveProviderTab(activeProvider);
  }, [activeProvider]);

  // 桌面/CLI 入口按宿主机实测结果控制：加载完成前两个图标都隐藏，避免闪烁。
  // runningAccounts 记录桌面运行中的账号，用于给图标挂角标。
  const [appEntries, setAppEntries] = useState<Record<string, { desktop: boolean; cli: boolean }> | null>(null);
  const [appCapabilities, setAppCapabilities] = useState<Record<string, { desktop: boolean; cli: boolean }>>({});
  const [runningAccounts, setRunningAccounts] = useState<string[]>([]);
  const cliClickTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [cliPickerAccount, setCliPickerAccount] = useState<Account | null>(null);
  const [kimiDesktopLoginRequest, setKimiDesktopLoginRequest] = useState<{
    account: Account;
    openAfterLogin: boolean;
  } | null>(null);
  const [codexResetAccount, setCodexResetAccount] = useState<Account | null>(null);
  const [quotaResetHistoryAccount, setQuotaResetHistoryAccount] = useState<Account | null>(null);
  const [accountEgressAccount, setAccountEgressAccount] = useState<Account | null>(null);
  const [cliTerminals, setCliTerminals] = useState<ClientTerminalItem[]>([]);
  const [selectedCliTerminalId, setSelectedCliTerminalId] = useState('system-default');
  const [cliTerminalsLoading, setCliTerminalsLoading] = useState(false);
  const [cliHomeDir, setCliHomeDir] = useState('');
  const [cliWorkdir, setCliWorkdir] = useState('');
  const [cliWorkdirHistory, setCliWorkdirHistory] = useState<string[]>(readCliWorkdirHistory);
  // 复用「会话-打开项目」的服务端目录浏览器（双击进入、单击选定、确认回填）。
  const cliDirectoryPicker = useServerDirectoryPicker(
    React.useCallback((path: string) => setCliWorkdir(path), [])
  );
  const updateCodexResetAvailableCount = React.useCallback((accountRef: string, availableCount: number) => {
    setAccounts((current) => current.map((item) => {
      if (item.provider !== 'codex' || getAccountRef(item) !== accountRef) return item;
      const resetCreditsAvailableCount = Math.max(0, Math.trunc(availableCount));
      if (item.usageSnapshot?.kind === 'codex_oauth_status') {
        if (item.usageSnapshot.resetCreditsAvailableCount === resetCreditsAvailableCount) return item;
        return {
          ...item,
          usageSnapshot: {
            ...item.usageSnapshot,
            resetCreditsAvailableCount
          }
        };
      }
      return {
        ...item,
        usageSnapshot: {
          kind: 'codex_oauth_status',
          capturedAt: Date.now(),
          entries: [],
          resetCreditsAvailableCount
        }
      };
    }));
  }, [setAccounts]);
  useEffect(() => () => {
    Object.values(cliClickTimers.current).forEach((timer) => clearTimeout(timer));
  }, []);
  const applyAppEntries = React.useCallback((result: Awaited<ReturnType<typeof accountsAPI.listAppEntries>>) => {
    setAppEntries(result.entries);
    setAppCapabilities(result.capabilities);
    setRunningAccounts(result.runningAccounts);
  }, []);
  const loadAppEntries = React.useCallback(async (options: { refresh?: boolean } = {}) => {
    try {
      const result = await accountsAPI.listAppEntries(options);
      applyAppEntries(result);
    } catch (_error) {
      setAppEntries((current) => current || {});
    }
  }, [applyAppEntries]);
  useEffect(() => startAccountAppEntryPolling({
    request: () => accountsAPI.listAppEntries(),
    onResult: applyAppEntries,
    onError: () => setAppEntries((current) => current || {})
  }), [applyAppEntries]);

  // 网关请求活动轮询：驱动账号行首图标「运行中」旋转，转速随请求速率变化。
  // 数据来自 /webui/management/metrics 的 accountActivity（服务端每 1s 刷新）。
  const [accountActivity, setAccountActivity] = useState<Record<string, ManagementAccountActivity> | null>(null);
  const accountActivityRef = useRef<Record<string, ManagementAccountActivity> | null>(null);
  accountActivityRef.current = accountActivity;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const metrics = await managementAPI.metrics();
        if (cancelled) return;
        setAccountActivity(metrics.accountActivity || null);
      } catch (_error) {
        if (!cancelled) setAccountActivity(null);
      }
    };
    poll();
    timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, []);

  const getAccountActivity = (record: Pick<Account, 'provider' | 'accountRef'>): ManagementAccountActivity | null => {
    const activities = accountActivityRef.current;
    if (!activities) return null;
    const key = `${String(record.provider).toLowerCase()}:${record.accountRef}`;
    return activities[key] || null;
  };

  accountsHandlersRef.current = {
    onImportJob: handleImportJobUpdate,
    onAuthJob: handleAuthJobUpdate,
    onAccountRefreshJob: handleAccountRefreshJobUpdate,
    onAccountLive: (account) => {
      clearAccountUsageRefresh(getAccountRef(account));
      clearModelAccountRefreshing(getModelRefreshAccountRef(account));
    },
    onAccountRemoved: (event, removedAccount) => {
      clearAccountUsageRefresh(getAccountRef(event));
      clearModelAccountRefreshing(removedAccount ? getModelRefreshAccountRef(removedAccount) : '');
    },
    onRemovalCleanup: (accountRef) => {
      clearAccountUsageRefresh(accountRef);
      setUpdatingStatusAccountRefs((current) => {
        if (!current[accountRef]) return current;
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
    },
    onTokenConsumed: (event: TokenConsumedEvent) => {
      const total = Number(event.tokens && event.tokens.total) || 0;
      if (total <= 0) return;
      const drop: TokenDropEvent = {
        id: `live-${event.accountRef}-${event.occurredAt}-${total}`,
        provider: String(event.provider || ''),
        accountRef: String(event.accountRef || ''),
        deltaTokens: Math.max(1, Math.round(total)),
        deltaCostUsd: null,
        occurredAt: Number(event.occurredAt) || Date.now()
      };
      setLiveTokenDrops((current) => appendLiveTokenEvent(current, drop));
    }
  };

  useEffect(() => {
    return () => {
      if (successAutoCloseTimerRef.current !== null) {
        window.clearTimeout(successAutoCloseTimerRef.current);
        successAutoCloseTimerRef.current = null;
      }
      Object.values(refreshingUsageFallbackTimersRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
      refreshingUsageFallbackTimersRef.current = {};
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
      reauth: flowKind === 'reauth',
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

  const handleOpenApp = async (record: Account, kind: 'desktop' | 'cli', terminalId?: string, workdir?: string): Promise<boolean> => {
    try {
      const result = await accountsAPI.openApp(record.provider, record.accountRef, kind, 'open', terminalId, workdir);
      if (result.egressWarning) {
        message.warning(`账号出口未生效：${result.egressWarning}`);
      }
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
              loadAppEntries({ refresh: true });
            } catch (error: any) {
              message.error(error?.response?.data?.message || '关闭 Desktop 应用失败');
            }
          }
        });
        return false;
      }
      message.success(kind === 'desktop' ? '已打开 Desktop 应用' : '已打开 CLI 终端');
      loadAppEntries({ refresh: true });
      return true;
    } catch (error: any) {
      const code = String(error?.response?.data?.error || '').trim();
      if (code === 'install_required') {
        if (error?.response?.data?.installAvailable === false) {
          Modal.info({
            title: `无法自动安装${kind === 'desktop' ? ' Desktop 应用' : '原生 CLI'}`,
            content: `${error?.response?.data?.message || '当前平台没有可用的自动安装器。'} 可前往 Toolkit > 应用管理查看当前主机状态；完成手动安装后重新点击图标。`,
            okText: '打开 Toolkit',
            onOk: () => navigate('/toolkit')
          });
          return false;
        }
        setAccountAppInstallPrompt({
          record,
          kind,
          terminalId,
          workdir,
          message: error?.response?.data?.message || '当前主机尚未安装目标客户端。'
        });
        return false;
      }
      if (code === 'account_unconfigured') {
        message.warning('账号尚未配置，完成授权或配置密钥后才能打开');
        return false;
      }
      if (code === 'account_auth_invalid') {
        message.warning('账号认证已失效，请重新登录后再打开');
        return false;
      }
      if (kind === 'desktop' && record.provider === 'kimi'
        && (code === 'kimi_desktop_session_required' || code === 'kimi_desktop_session_seed_failed')) {
        setKimiDesktopLoginRequest({ account: record, openAfterLogin: true });
        if (code === 'kimi_desktop_session_seed_failed') {
          message.warning(error?.response?.data?.message || 'Kimi Desktop 登录态需要重新托管');
        }
        return false;
      }
      if (code === 'agy_desktop_restart_required') {
        Modal.confirm({
          title: 'Antigravity Desktop 需要重启',
          content: '当前账号凭据已变化。关闭正在运行的实例并重新打开后，Desktop 才会使用当前账号登录态。',
          okText: '关闭并重新打开',
          cancelText: '取消',
          onOk: async () => {
            try {
              await accountsAPI.openApp(record.provider, record.accountRef, 'desktop', 'close');
              await accountsAPI.openApp(record.provider, record.accountRef, 'desktop', 'open', terminalId);
              message.success('已重新打开 Desktop 应用');
              loadAppEntries({ refresh: true });
            } catch (restartError: any) {
              message.error(restartError?.response?.data?.message || '重启 Desktop 应用失败');
            }
          }
        });
        return false;
      }
      if (code === 'agy_desktop_keychain_conflict') {
        message.warning('检测到其他 Antigravity Desktop 实例，请先关闭其他实例后再打开此账号');
        return false;
      }
      if (code === 'agy_desktop_auth_unavailable') {
        message.warning('当前账号没有可用的 Antigravity OAuth 凭据，请先完成授权后再打开 Desktop');
        return false;
      }
      message.error(error?.response?.data?.message || (kind === 'desktop' ? '打开 Desktop 应用失败' : '打开 CLI 终端失败'));
      return false;
    }
  };

  const runAccountAppInstall = async (prompt: AccountAppInstallPrompt) => {
    if (accountAppInstallSubmitting) return;
    setAccountAppInstallSubmitting(true);
    setAccountAppInstallPrompt(null);
    try {
      const appId = prompt.kind === 'desktop' ? `${prompt.record.provider}-desktop` : prompt.record.provider;
      const response = await toolkitAPI.executeAppAction(appId, 'install', prompt.kind);
      if (!response.ok || !response.job) {
        throw new Error(response.error || 'Toolkit 未创建安装任务');
      }
      message.info('安装任务已交给 Toolkit 应用管理，进度显示在右下角任务队列。');
      const completed = await waitForAppInstallJob(response.job.id);
      if (completed.status === 'succeeded') {
        await loadAppEntries({ refresh: true });
      }
      setAccountAppInstallResult({ prompt, job: completed });
    } catch (installError: any) {
      setAccountAppInstallResult({
        prompt,
        job: null,
        error: installError?.response?.data?.message || installError?.message || '安装失败'
      });
    } finally {
      setAccountAppInstallSubmitting(false);
    }
  };

  const confirmAccountAppInstall = async () => {
    if (!accountAppInstallPrompt) return;
    await runAccountAppInstall(accountAppInstallPrompt);
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
      const homeDir = String(response.homeDir || '').trim();
      setCliHomeDir(homeDir);
      setCliWorkdir(homeDir);
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
    void handleOpenApp(record, 'cli', 'system-default', cliHomeDir || undefined);
  };

  // 仅记录用户显式选择的非默认目录；默认 home 由选择器内置提供，不进历史。
  const rememberCliWorkdir = (workdir: string) => {
    const normalized = workdir.trim();
    if (!normalized || normalized === cliHomeDir) return;
    const next = [normalized, ...cliWorkdirHistory.filter((item) => item !== normalized)]
      .slice(0, CLI_WORKDIR_HISTORY_LIMIT);
    setCliWorkdirHistory(next);
    persistCliWorkdirHistory(next);
  };

  const clearCliWorkdirHistory = () => {
    setCliWorkdirHistory([]);
    persistCliWorkdirHistory([]);
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
      } else if (state === 'reauth_required') {
        stats.all.reauthRequired++;
        providerBucket.reauthRequired++;
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

  const openModelManagement = React.useCallback((record: Account) => {
    if (requiresAccountReauth(record)) return;
    navigate(`/accounts/${encodeURIComponent(record.provider)}/${encodeURIComponent(record.accountRef)}/models`);
  }, [navigate]);

  // 账号操作菜单（⋮）—— 桌面表格列和移动卡片共用同一套 items + 点击分发，避免逻辑分叉。
  const buildAccountMenuItems = (record: Account): MenuProps['items'] => {
    if (requiresAccountReauth(record)) {
      return [{ key: 'reauth', label: '重新登录', icon: <SyncOutlined /> }];
    }
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
    if (isCodexOAuthResetEligible(record)) {
      menuItems.push({
        key: 'codex-reset-credits',
        label: formatCodexResetMenuLabel(record),
        icon: <UndoOutlined />
      });
    }
    if (!record.apiKeyMode) {
      menuItems.push({
        key: 'quota-reset-history',
        label: '重置历史记录',
        icon: <HistoryOutlined />
      });
    }
    if (canReauthAccount(record)) {
      menuItems.push({ key: 'reauth', label: getReauthActionLabel(record), icon: <SyncOutlined /> });
    }
    if (canEditAccountConfig(record)) {
      menuItems.push({ key: 'edit', label: '编辑配置', icon: <EditOutlined /> });
    }
    menuItems.push({ key: 'account-egress', label: '出口设置', icon: <GlobalOutlined /> });
    menuItems.push({ type: 'divider' });
    menuItems.push({ key: 'delete', label: '删除账号', danger: true, icon: <DeleteOutlined /> });
    return menuItems;
  };

  const handleAccountMenuClick = (record: Account, key: string) => {
    if (requiresAccountReauth(record) && key !== 'reauth') return;
    if (key === 'set-default') { handleSetDefault(record); return; }
    if (key === 'set-mobile') { handleSetMobile(record); return; }
    if (key === 'codex-reset-credits' && isCodexOAuthResetEligible(record)) {
      setCodexResetAccount(record);
      return;
    }
    if (key === 'quota-reset-history') {
      setQuotaResetHistoryAccount(record);
      return;
    }
    if (key === 'reauth') { handleReauth(record); return; }
    if (key === 'edit' && canEditAccountConfig(record)) { handleEdit(record); return; }
    if (key === 'account-egress') {
      setAccountEgressAccount(record);
      return;
    }
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
      render: (_text: any, record: Account) => {
        const requiresReauth = requiresAccountReauth(record);
        const desktopInstalled = Boolean(appEntries?.[record.provider]?.desktop);
        const desktopSupported = Boolean(
          appEntries?.[record.provider]?.desktop || appCapabilities[record.provider]?.desktop
        );
        const cliInstalled = Boolean(appEntries?.[record.provider]?.cli);
        const cliSupported = Boolean(
          PROVIDER_CATALOG[record.provider as Provider]?.clients?.cli
            && (appEntries?.[record.provider]?.cli || appCapabilities[record.provider]?.cli)
        );
        const desktopEntryClassName = desktopInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';
        const cliEntryClassName = cliInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';

        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ paddingTop: 3, flexShrink: 0 }}>
            <AccountActivityIcon provider={record.provider} activity={getAccountActivity(record)} size={18} />
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
              {renderAccountRegionTag(record)}
              {/* 操作按钮必须保持语义化图标（DesktopOutlined / CodeOutlined），禁止替换为 ProviderIcon，避免与行首厂商主图标混淆 */}
              {appEntries && desktopSupported ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能打开 Desktop' : !record.configured ? '账号未配置，完成授权后可打开 Desktop' : runningAccounts.includes(getAccountRef(record)) ? 'Desktop 运行中（点击关闭）' : desktopInstalled ? '打开 Desktop' : '未安装 Desktop，点击后确认安装'}>
                  <Badge dot={runningAccounts.includes(getAccountRef(record))} status="success">
                    <Button
                      className={desktopEntryClassName}
                      type="text"
                      size="small"
                      aria-label={desktopInstalled
                        ? `打开 ${providerNames[record.provider] || record.provider} Desktop`
                        : `安装 ${providerNames[record.provider] || record.provider} Desktop`}
                      icon={<DesktopOutlined />}
                      disabled={requiresReauth || !record.configured}
                      onClick={(event: any) => {
                        event?.stopPropagation?.();
                        handleOpenApp(record, 'desktop');
                      }}
                    />
                  </Badge>
                </Tooltip>
              ) : null}
              {record.provider === 'kimi' ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能使用桌面托管登录' : '桌面托管登录（微信扫码）'}>
                  <Button
                    type="text"
                    size="small"
                    aria-label="kimi 桌面托管登录"
                    icon={<QrcodeOutlined />}
                    disabled={requiresReauth}
                    onClick={(event: any) => {
                      event?.stopPropagation?.();
                      setKimiDesktopLoginRequest({ account: record, openAfterLogin: false });
                    }}
                  />
                </Tooltip>
              ) : null}
              {appEntries && cliSupported ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能打开 CLI' : !record.configured ? '账号未配置，完成授权后可打开 CLI' : cliInstalled ? '单击选择终端，双击使用系统默认终端' : '未安装原生 CLI，点击后确认安装'}>
                  <Button
                    className={cliEntryClassName}
                    type="text"
                    size="small"
                    aria-label={cliInstalled
                      ? `打开 ${providerNames[record.provider] || record.provider} CLI`
                      : `安装 ${providerNames[record.provider] || record.provider} CLI`}
                    icon={<CodeOutlined />}
                    disabled={requiresReauth || !record.configured}
                    onClick={(event: any) => {
                      event?.stopPropagation?.();
                      if (!cliInstalled) {
                        void handleOpenApp(record, 'cli');
                        return;
                      }
                      scheduleCliTerminalPicker(record);
                    }}
                    onDoubleClick={(event: any) => {
                      event?.stopPropagation?.();
                      if (cliInstalled) openCliWithDefaultTerminal(record);
                    }}
                  />
                </Tooltip>
              ) : null}
            </div>
          </div>
          </div>
        );
      },
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
        const requiresReauth = requiresAccountReauth(record);
        return (
          <span style={{ display: 'inline-flex', justifyContent: 'center', width: 64 }}>
            <Switch
              checked={enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              loading={Boolean(updatingStatusAccountRefs[accountRef])}
              disabled={requiresReauth}
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
        const requiresReauth = requiresAccountReauth(record);
        const probe = getAccountModelProbe(record, modelCatalog);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing, record.provider);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="accounts-model-probe">
            <span
              className={requiresReauth ? undefined : 'accounts-model-probe-badge-link'}
              role={requiresReauth ? undefined : 'button'}
              tabIndex={requiresReauth ? undefined : 0}
              onClick={requiresReauth ? undefined : () => openModelManagement(record)}
              onKeyDown={requiresReauth ? undefined : (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openModelManagement(record);
              }}
              style={{
                cursor: requiresReauth ? 'default' : 'pointer',
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
                disabled={requiresReauth}
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
        <UsageProgressEffects
          record={record}
          activity={getAccountActivity(record)}
          drops={tokenDrops}
        />
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
      width: 112,
      align: 'center' as const,
      fixed: 'right' as const,
      render: (_: any, record: Account) => (
        requiresAccountReauth(record) ? (
          <Button type="link" size="small" icon={<SyncOutlined />} onClick={() => handleReauth(record)}>
            重新登录
          </Button>
        ) : (
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
      )
    }
  ];

  // 移动端账号卡片 —— 把桌面宽表的一行数据竖排成一张卡（对齐 §2 表格→卡片列表）。
  // 复用桌面同款渲染 helper 和操作分发，逻辑不分叉；一切文本省略、不横向溢出。
  const renderAccountCard = (record: Account) => {
    const accountRef = getAccountRef(record);
    const enabled = isAccountEnabled(record);
    const requiresReauth = requiresAccountReauth(record);
    const probe = getAccountModelProbe(record, modelCatalog);
    const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
    const lastUsed = formatTimeCell(record.lastUsedAt);
    return (
      <div className="mobile-card account-mobile-card" key={accountRef} data-account-ref={accountRef}>
        <div className="mobile-card-head">
          <span className="mobile-card-head-icon">
            <AccountActivityIcon provider={record.provider} activity={getAccountActivity(record)} size={22} />
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
            <button
              className="m-card-more"
              aria-label={requiresReauth ? '重新登录' : '更多操作'}
              onClick={() => {
                if (requiresReauth) {
                  void handleReauth(record);
                  return;
                }
                setActionAccount(record);
              }}
            >
              {requiresReauth ? <SyncOutlined /> : <MoreOutlined />}
            </button>
          </div>
        </div>

        {/* 状态 + 模型探测(轻量一行,可点探测进模型管理) */}
        <div className="account-mobile-meta">
          <span className="account-mobile-status">{renderAccountDisplayBadge(record)}</span>
          {renderAccountRegionTag(record)}
          <span
            className={requiresReauth ? undefined : 'account-mobile-probe'}
            role={requiresReauth ? undefined : 'button'}
            tabIndex={requiresReauth ? undefined : 0}
            onClick={requiresReauth ? undefined : () => openModelManagement(record)}
          >
            <Badge
              status={getModelProbeTagColor(probe, modelRefreshing) as any}
              text={getModelProbeTagLabel(probe, modelRefreshing, record.provider)}
            />
          </span>
        </div>
        {/* 用量快照 */}
        <div className="account-mobile-usage">
          <UsageProgressEffects
            record={record}
            activity={getAccountActivity(record)}
            drops={tokenDrops}
          />
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
            disabled={requiresReauth}
            onChange={(checked) => handleToggleStatus(record, checked)}
          />
          <span className="mobile-card-foot-hint">
            {lastUsed ? `上次使用 ${lastUsed.relative}` : '尚无使用记录'}
          </span>
        </div>
      </div>
    );
  };

  // provider tab 聚合账号活动，复用行首图标组件，保证转轴与速率语义完全一致。
  const providerActivity: Record<string, ManagementAccountActivity> = {};
  accounts.forEach((account) => {
    const activity = getAccountActivity(account);
    if (!activity) return;
    const provider = String(account.provider).toLowerCase();
    const current = providerActivity[provider];
    providerActivity[provider] = {
      provider,
      accountRef: '*',
      inFlight: (current?.inFlight || 0) + Math.max(0, Number(activity.inFlight) || 0),
      rate: (current?.rate || 0) + Math.max(0, Number(activity.rate) || 0),
      lastActivityAt: Math.max(current?.lastActivityAt || 0, Number(activity.lastActivityAt) || 0),
      updatedAt: Math.max(current?.updatedAt || 0, Number(activity.updatedAt) || 0)
    };
  });

  const tabItems = [
    {
      key: 'all',
      label: <span style={{ padding: '0 8px' }}>全部 ({providerStats.all.total})</span>
    },
    ...PROVIDERS.map((provider) => ({
      key: provider,
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <AccountActivityIcon
            provider={provider}
            activity={providerActivity[provider] || null}
            size={14}
          />
          {providerNames[provider]} ({providerStats[provider].total})
        </span>
      )
    }))
  ];
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
      title="账号管理"
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
        /* 手机版只保留两张有信息量的卡:正常可用 / 需登录·不可用。
           「账号状态」恒为就绪,信息量低,已移除;
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
              label: '需登录/不可用',
              value: providerStats[activeProvider].reauthRequired + providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked,
              hint: `需登录 ${providerStats[activeProvider].reauthRequired} · 耗尽 ${providerStats[activeProvider].exhausted} · 停池 ${providerStats[activeProvider].policyBlocked}`,
              valueColor: providerStats[activeProvider].reauthRequired + providerStats[activeProvider].exhausted + providerStats[activeProvider].policyBlocked > 0
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
              value: providerStats[activeProvider].reauthRequired + providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention,
              description: `需登录 ${providerStats[activeProvider].reauthRequired} · 阻塞 ${providerStats[activeProvider].runtimeBlocked} · 待校准 ${providerStats[activeProvider].usageAttention}`,
              valueStyle: {
                color: providerStats[activeProvider].reauthRequired + providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention > 0
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
        <div className="accounts-import-running" role="status" aria-live="polite">
          <SyncOutlined spin aria-hidden="true" />
          <strong>账号导入正在后台运行</strong>
          <span>{formatImportJobProgress(importJob)}</span>
        </div>
      ) : null}
      <ImportAccountsModal
        open={importModalVisible}
        importing={importingAccounts}
        canSubmit={canSubmitImport}
        mode={importMode}
        fileName={importFileName}
        pasteTemplate={pasteTemplate}
        importText={importText}
        onModeChange={handleImportModeChange}
        onTemplateChange={(template) => setPasteTemplate(template)}
        onTextChange={(text) => setImportText(text)}
        onPickFile={() => importInputRef.current?.click()}
        onPickFolder={() => importFolderInputRef.current?.click()}
        onFillTemplate={() => setImportText(PASTE_TEMPLATES[pasteTemplate].value)}
        onSubmit={handleImportSubmit}
        onCancel={closeImportModal}
      />

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
                  { key: 'reauth_required', label: '需要重新登录' },
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
          <SectionCard
            title="账号列表"
            extra={
              <Segmented
                value={viewMode}
                onChange={(val) => { const next = val as 'card' | 'list'; setViewMode(next); persistAccountsViewMode(next); }}
                options={[
                  { value: 'card', icon: <AppstoreOutlined />, label: '卡片' },
                  { value: 'list', icon: <UnorderedListOutlined />, label: '列表' },
                ]}
              />
            }
          >
          {viewMode === 'card' ? (
            <div style={{ marginBottom: 16 }}>
              <AccountCardGrid
                accounts={filteredAccounts as any}
                provider={activeProvider}
                loading={loading}
                onEdit={(acc) => {
                  const target = accounts.find(a => a.accountRef === acc.accountRef);
                  if (target) handleOpenEdit(target);
                }}
                onDelete={(acc) => {
                  const target = accounts.find(a => a.accountRef === acc.accountRef);
                  if (target) handleDelete(target);
                }}
                onOpenApp={(acc) => {
                  const target = accounts.find(a => a.accountRef === acc.accountRef);
                  if (target) handleOpenDesktop(target);
                }}
                onOpenCli={(acc) => {
                  const target = accounts.find(a => a.accountRef === acc.accountRef);
                  if (target) handleOpenPty(target);
                }}
              />
            </div>
          ) : (
            <ListTable
            headerTitle={
              <Space size={12}>
                <Badge status="success" text={`可用 ${providerStats[activeProvider].healthy}`} />
                {providerStats[activeProvider].reauthRequired + providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention > 0 && (
                  <Badge status="warning" text={`待处理 ${providerStats[activeProvider].reauthRequired + providerStats[activeProvider].runtimeBlocked + providerStats[activeProvider].usageAttention}`} />
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
                  style={{ width: 156 }}
                  options={[
                    { label: '全部状态', value: 'all' },
                    { label: '正常可用', value: 'healthy' },
                    { label: '需要重新登录', value: 'reauth_required' },
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
          )}
        </SectionCard>
      )}

      <EditAccountModal
        open={editModalVisible}
        form={editForm}
        isClaudeCredential={isEditingClaudeCredential}
        effectiveAuthMode={effectiveEditAuthMode}
        credentialModeChanged={isEditCredentialModeChanged}
        onClose={() => setEditModalVisible(false)}
        onSubmit={handleEditSubmit}
      />

      <AddAccountModal
        open={modalVisible}
        form={form}
        submitting={submitting}
        onSubmit={handleAdd}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
        }}
      />

      <AuthProgressModal
        open={authProgressVisible}
        job={addJob}
        subjectLabel={authSubjectLabel}
        successClosing={authSuccessClosing}
        callbackUrl={authCallbackUrl}
        callbackSubmitting={authCallbackSubmitting}
        cliInstallSubmitting={cliInstallSubmitting}
        canSubmitCallback={canSubmitBrowserCallback}
        onClose={() => closeAuthProgress(false)}
        onCallbackUrlChange={setAuthCallbackUrl}
        onSubmitBrowserCallback={handleSubmitBrowserCallback}
        onConfirmCliInstall={handleConfirmCliInstall}
      />
      <AccountAppInstallModal
        open={Boolean(accountAppInstallPrompt)}
        providerName={accountAppInstallPrompt ? (providerNames[accountAppInstallPrompt.record.provider] || accountAppInstallPrompt.record.provider) : ''}
        kind={accountAppInstallPrompt?.kind || 'desktop'}
        message={accountAppInstallPrompt?.message || ''}
        confirmLoading={accountAppInstallSubmitting}
        onConfirm={confirmAccountAppInstall}
        onCancel={() => {
          if (!accountAppInstallSubmitting) setAccountAppInstallPrompt(null);
        }}
      />
      <AccountAppInstallResultModal
        open={Boolean(accountAppInstallResult)}
        providerName={accountAppInstallResult ? (providerNames[accountAppInstallResult.prompt.record.provider] || accountAppInstallResult.prompt.record.provider) : ''}
        accountLabel={accountAppInstallResult ? getAccountPrimaryLabel(accountAppInstallResult.prompt.record) : ''}
        kind={accountAppInstallResult?.prompt.kind || 'desktop'}
        job={accountAppInstallResult?.job || null}
        error={accountAppInstallResult?.error}
        onOpenApp={() => {
          const result = accountAppInstallResult;
          if (!result) return;
          setAccountAppInstallResult(null);
          void handleOpenApp(result.prompt.record, result.prompt.kind, result.prompt.terminalId, result.prompt.workdir);
        }}
        onRetry={() => {
          const result = accountAppInstallResult;
          if (!result) return;
          setAccountAppInstallResult(null);
          void runAccountAppInstall(result.prompt);
        }}
        onClose={() => setAccountAppInstallResult(null)}
      />
      <CliPickerModal
        account={cliPickerAccount}
        terminals={cliTerminals}
        selectedTerminalId={selectedCliTerminalId}
        loading={cliTerminalsLoading}
        workdir={cliWorkdir}
        workdirHistory={cliWorkdirHistory}
        onTerminalChange={setSelectedCliTerminalId}
        onWorkdirChange={setCliWorkdir}
        onBrowseWorkdir={cliDirectoryPicker.open}
        onClearWorkdirHistory={clearCliWorkdirHistory}
        onCancel={() => setCliPickerAccount(null)}
        onOpen={(account, terminalId, workdir) => {
          setCliPickerAccount(null);
          void handleOpenApp(account, 'cli', terminalId, workdir || undefined).then((opened) => {
            if (opened) rememberCliWorkdir(workdir);
          });
        }}
      />
      <DirectoryPickerDialog
        open={cliDirectoryPicker.visible}
        currentPath={cliDirectoryPicker.currentPath}
        parentPath={cliDirectoryPicker.parentPath}
        directories={cliDirectoryPicker.directories}
        loading={cliDirectoryPicker.loading}
        selectedPath={cliDirectoryPicker.selectedPath}
        onCancel={cliDirectoryPicker.close}
        onConfirm={cliDirectoryPicker.confirm}
        onNavigate={cliDirectoryPicker.load}
        onSelect={cliDirectoryPicker.select}
      />
      <KimiDesktopLoginModal
        open={Boolean(kimiDesktopLoginRequest)}
        accountRef={kimiDesktopLoginRequest ? getAccountRef(kimiDesktopLoginRequest.account) : ''}
        accountLabel={kimiDesktopLoginRequest ? getAccountPrimaryLabel(kimiDesktopLoginRequest.account) : ''}
        onClose={() => setKimiDesktopLoginRequest(null)}
        onSuccess={() => {
          const request = kimiDesktopLoginRequest;
          setKimiDesktopLoginRequest(null);
          if (request?.openAfterLogin) void handleOpenApp(request.account, 'desktop');
        }}
      />
      <CodexResetCreditsModal
        open={Boolean(codexResetAccount)}
        account={codexResetAccount}
        onClose={() => setCodexResetAccount(null)}
        onAvailableCountChange={updateCodexResetAvailableCount}
      />
      <AccountQuotaResetHistoryModal
        open={Boolean(quotaResetHistoryAccount)}
        account={quotaResetHistoryAccount}
        onClose={() => setQuotaResetHistoryAccount(null)}
      />
      <AccountEgressModal
        account={accountEgressAccount}
        onClose={() => setAccountEgressAccount(null)}
      />
    </PageScaffold>
  );
};
