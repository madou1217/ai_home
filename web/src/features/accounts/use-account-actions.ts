import React from 'react';
import { Form, Modal, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import {
  accountsAPI,
  toolkitAPI,
  waitForAppInstallJob
} from '@/services/api';
import type { AccountExportFormat, AccountImportUploadFile, TokenConsumedEvent } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAppLaunchResponse,
  AccountAuthMode,
  AccountImportJob,
  AccountRefreshJob,
  AppInstallJob,
  ClientTerminalItem,
  Provider
} from '@/types';
import { providerNames } from '@/components/chat/ProviderIcon';
import { PROVIDER_AUTH_OPTIONS } from '@/providers/catalog';
import {
  applyAccountTokenUsageDelta,
  canCopyAccountEmail,
  canEditAccountConfig,
  getClaudeCredentialMode,
  mergeSingleAccount,
  reconcileAccountAfterReauthSuccess,
  requiresAccountReauth
} from '@/features/accounts/account-state';
import {
  getAccountRef,
  getModelRefreshAccountRef
} from '@/features/accounts/account-model-catalog';
import {
  buildImportResponseFromJob,
  describeImportSelection,
  formatImportResult,
  readImportUploadFiles
} from '@/features/accounts/account-import-export';
import type { ImportMode, ImportUploadKind, PasteTemplate } from '@/features/accounts/account-import-export';
import { getAccountLaunchBlockReason } from '@/features/accounts/account-view-model';
import type {
  UseAccountsSnapshotHandlers,
  UseAccountsSnapshotResult
} from '@/features/accounts/useAccountsSnapshot';
import type { UseModelCatalogResult } from '@/features/accounts/useModelCatalog';
import { getAuthJobIdentity, getCallbackUiCopy } from '@/features/accounts/AuthProgressModal';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import { useServerDirectoryPicker } from '@/features/legacy-chat/use-server-directory-picker';

// 账号页全部业务动作 —— 从 Accounts.tsx 抽取的状态与处理函数（添加 / 授权进度 / 重新认证 /
// 编辑凭据 / 导入导出 / 启停 / 默认账号 / 用量刷新 / 删除 / 打开 Desktop·CLI / 应用安装 …）。
// 桌面 Accounts.tsx 与移动端 MobileAccounts 共用同一套实现：同样的 API 调用、同样的守卫与提示文案。
// 业务弹窗统一由 AccountFlowModals 渲染（出口设置弹窗由页面自己渲染）。

const AUTH_JOB_FALLBACK_POLL_MS = 5000;
const ACCOUNT_REFRESH_FALLBACK_CLEAR_MS = 70_000;
const CLI_WORKDIR_HISTORY_STORAGE_KEY = 'accounts-cli-workdir-history:v1';
const CLI_WORKDIR_HISTORY_LIMIT = 10;

export type AccountAppInstallKind = 'desktop' | 'cli';

export interface AccountAppInstallPrompt {
  record: Account;
  kind: AccountAppInstallKind;
  terminalId?: string;
  workdir?: string;
  message: string;
}

export interface AccountAppInstallResult {
  prompt: AccountAppInstallPrompt;
  job: AppInstallJob | null;
  error?: string;
}

export interface KimiDesktopLoginRequest {
  account: Account;
  openAfterLogin: boolean;
}

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

export interface UseAccountActionsOptions {
  snapshot: Pick<UseAccountsSnapshotResult, 'setAccounts' | 'requestAccountsSnapshotUpdate' | 'stageAccountRemoval'>;
  handlersRef: React.MutableRefObject<UseAccountsSnapshotHandlers>;
  modelCatalog: Pick<UseModelCatalogResult, 'clearModelAccountRefreshing' | 'loadModelCatalog'>;
  loadAppEntries: (options?: { refresh?: boolean }) => Promise<void>;
  /** openApp 请求成功返回后立即回调（页面据此提示账号出口未生效等附加信息）。 */
  onOpenAppResponse?: (result: AccountAppLaunchResponse) => void;
}

export function useAccountActions({
  snapshot,
  handlersRef,
  modelCatalog,
  loadAppEntries,
  onOpenAppResponse
}: UseAccountActionsOptions) {
  const navigate = useNavigate();
  const { setAccounts, requestAccountsSnapshotUpdate, stageAccountRemoval } = snapshot;
  const { clearModelAccountRefreshing, loadModelCatalog } = modelCatalog;
  const onOpenAppResponseRef = React.useRef(onOpenAppResponse);
  onOpenAppResponseRef.current = onOpenAppResponse;

  const [updatingStatusAccountRefs, setUpdatingStatusAccountRefs] = React.useState<Record<string, boolean>>({});
  const [refreshingUsageAccountRefs, setRefreshingUsageAccountRefs] = React.useState<Record<string, boolean>>({});
  const [modalVisible, setModalVisible] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [addJobId, setAddJobId] = React.useState<string | null>(null);
  const [addJob, setAddJob] = React.useState<AccountAddJob | null>(null);
  const [authProgressVisible, setAuthProgressVisible] = React.useState(false);
  const [authSuccessClosing, setAuthSuccessClosing] = React.useState(false);
  const [authFlowKind, setAuthFlowKind] = React.useState<'add' | 'reauth'>('add');
  const [authSubjectLabel, setAuthSubjectLabel] = React.useState('');
  const [authCallbackUrl, setAuthCallbackUrl] = React.useState('');
  const [authCallbackSubmitting, setAuthCallbackSubmitting] = React.useState(false);
  const [cliInstallSubmitting, setCliInstallSubmitting] = React.useState(false);
  const [accountAppInstallPrompt, setAccountAppInstallPrompt] = React.useState<AccountAppInstallPrompt | null>(null);
  const [accountAppInstallSubmitting, setAccountAppInstallSubmitting] = React.useState(false);
  const [accountAppInstallResult, setAccountAppInstallResult] = React.useState<AccountAppInstallResult | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editModalVisible, setEditModalVisible] = React.useState(false);
  const [editingAccount, setEditingAccount] = React.useState<Account | null>(null);
  const [importModalVisible, setImportModalVisible] = React.useState(false);
  const [importMode, setImportMode] = React.useState<ImportMode>('file');
  const [pasteTemplate, setPasteTemplate] = React.useState<PasteTemplate>('sub2api');
  const [importText, setImportText] = React.useState('');
  const [importFileName, setImportFileName] = React.useState('');
  const [importFiles, setImportFiles] = React.useState<AccountImportUploadFile[]>([]);
  const [importingAccounts, setImportingAccounts] = React.useState(false);
  const [importJobId, setImportJobId] = React.useState<string | null>(null);
  const [importJob, setImportJob] = React.useState<AccountImportJob | null>(null);
  const [exportingAccounts, setExportingAccounts] = React.useState(false);
  const [cliPickerAccount, setCliPickerAccount] = React.useState<Account | null>(null);
  const [kimiDesktopLoginRequest, setKimiDesktopLoginRequest] = React.useState<KimiDesktopLoginRequest | null>(null);
  const [codexResetAccount, setCodexResetAccount] = React.useState<Account | null>(null);
  const [quotaResetHistoryAccount, setQuotaResetHistoryAccount] = React.useState<Account | null>(null);
  const [accountEgressAccount, setAccountEgressAccount] = React.useState<Account | null>(null);
  const [cliTerminals, setCliTerminals] = React.useState<ClientTerminalItem[]>([]);
  const [selectedCliTerminalId, setSelectedCliTerminalId] = React.useState('system-default');
  const [cliTerminalsLoading, setCliTerminalsLoading] = React.useState(false);
  const [cliHomeDir, setCliHomeDir] = React.useState('');
  const [cliWorkdir, setCliWorkdir] = React.useState('');
  const [cliWorkdirHistory, setCliWorkdirHistory] = React.useState<string[]>(readCliWorkdirHistory);
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const importFolderInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const completedImportJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedAuthJobKeysRef = React.useRef<Set<string>>(new Set());
  const completedRefreshJobKeysRef = React.useRef<Set<string>>(new Set());
  const refreshingUsageFallbackTimersRef = React.useRef<Record<string, number>>({});
  const previousAddProviderRef = React.useRef<Provider | undefined>(undefined);
  const cliClickTimers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
  // 复用「会话-打开项目」的服务端目录浏览器（双击进入、单击选定、确认回填）。
  const cliDirectoryPicker = useServerDirectoryPicker(
    React.useCallback((path: string) => setCliWorkdir(path), [])
  );

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

  const openImportModal = React.useCallback(() => {
    setImportModalVisible(true);
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
    if (nextMode === importMode) return;
    setImportMode(nextMode);
    if (nextMode !== 'text') setImportText('');
    // 文件 / 文件夹两种上传的 uploadKind 语义不同，切换模式时清空已选文件。
    setImportFileName('');
    setImportFiles([]);
  };

  const handleImportFilesSelected = async (kind: ImportUploadKind, fileList: FileList | File[] | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    try {
      const uploads = await readImportUploadFiles(files);
      setImportFiles(uploads);
      setImportFileName(describeImportSelection(files, kind));
    } catch (error: any) {
      setImportFiles([]);
      setImportFileName('');
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
        setAccounts((current) => reconcileAccountAfterReauthSuccess(current, job.accountRef) as Account[]);
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

  React.useEffect(() => () => {
    Object.values(cliClickTimers.current).forEach((timer) => clearTimeout(timer));
  }, []);

  handlersRef.current = {
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
      setAccounts((current) => current.map((account) => (
        applyAccountTokenUsageDelta(account, event)
      )));
    }
  };

  React.useEffect(() => {
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

  React.useEffect(() => {
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

  React.useEffect(() => {
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

  /** 打开「添加账号」弹窗；defaultProvider 由页面按当前 Provider 族筛选给出（见 resolveAddAccountDefaultProvider）。 */
  const openAddAccountModal = React.useCallback((defaultProvider?: Provider) => {
    setEditingAccount(null);
    form.setFieldsValue({ provider: defaultProvider });
    setModalVisible(true);
  }, [form]);

  const closeAddAccountModal = React.useCallback(() => {
    setModalVisible(false);
    form.resetFields();
  }, [form]);

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

  // 所有视图（桌面列表 / 卡片、移动端）共用的删除确认，保证删除行为一致。
  const confirmDeleteAccount = (record: Account) => {
    Modal.confirm({
      title: '确认删除？',
      content: `将删除 ${getAccountPrimaryLabel(record)}`,
      okText: '确认',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => handleDelete(record.provider, record.accountRef)
    });
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
      onOpenAppResponseRef.current?.(result);
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

  const cancelAccountAppInstall = () => {
    if (!accountAppInstallSubmitting) setAccountAppInstallPrompt(null);
  };

  const openAppFromInstallResult = () => {
    const result = accountAppInstallResult;
    if (!result) return;
    setAccountAppInstallResult(null);
    void handleOpenApp(result.prompt.record, result.prompt.kind, result.prompt.terminalId, result.prompt.workdir);
  };

  const retryAccountAppInstall = () => {
    const result = accountAppInstallResult;
    if (!result) return;
    setAccountAppInstallResult(null);
    void runAccountAppInstall(result.prompt);
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

  // 桌面：单击延迟 240ms 打开终端选择器，期间双击则改为系统默认终端直接打开。
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

  const openCliFromPicker = (account: Account, terminalId: string, workdir: string) => {
    setCliPickerAccount(null);
    void handleOpenApp(account, 'cli', terminalId, workdir || undefined).then((opened) => {
      if (opened) rememberCliWorkdir(workdir);
    });
  };

  // 所有入口（桌面列表 / 卡片、移动端）打开 CLI / Desktop 前的同一条拦截（重新登录 / 未配置）。
  const guardAccountLaunch = (record: Account, kindLabel: string) => {
    const reason = getAccountLaunchBlockReason(record, kindLabel);
    if (reason) {
      message.warning(reason);
      return false;
    }
    return true;
  };

  const openModelManagement = React.useCallback((record: Account) => {
    if (requiresAccountReauth(record)) return;
    navigate(`/accounts/${encodeURIComponent(record.provider)}/${encodeURIComponent(record.accountRef)}/models`);
  }, [navigate]);

  return {
    // 行级状态
    updatingStatusAccountRefs,
    refreshingUsageAccountRefs,
    // 行级操作
    copyAccountEmail,
    handleEdit,
    handleReauth,
    confirmDeleteAccount,
    handleReload,
    handleToggleStatus,
    handleSetDefault,
    handleSetMobile,
    handleRefreshUsage,
    handleOpenApp,
    chooseCliTerminal,
    scheduleCliTerminalPicker,
    openCliWithDefaultTerminal,
    guardAccountLaunch,
    openModelManagement,
    // 页面级操作
    openAddAccountModal,
    openImportModal,
    handleExport,
    exportingAccounts,
    hasActiveImportJob,
    importJob,
    // 弹窗目标
    setKimiDesktopLoginRequest,
    setCodexResetAccount,
    setQuotaResetHistoryAccount,
    accountEgressAccount,
    setAccountEgressAccount,
    // AccountFlowModals 使用的弹窗状态与回调
    modals: {
      add: {
        open: modalVisible,
        form,
        submitting,
        onSubmit: handleAdd,
        onCancel: closeAddAccountModal
      },
      edit: {
        open: editModalVisible,
        form: editForm,
        isClaudeCredential: isEditingClaudeCredential,
        effectiveAuthMode: effectiveEditAuthMode,
        credentialModeChanged: isEditCredentialModeChanged,
        onClose: () => setEditModalVisible(false),
        onSubmit: handleEditSubmit
      },
      authProgress: {
        open: authProgressVisible,
        job: addJob,
        subjectLabel: authSubjectLabel,
        successClosing: authSuccessClosing,
        callbackUrl: authCallbackUrl,
        callbackSubmitting: authCallbackSubmitting,
        cliInstallSubmitting,
        canSubmitCallback: canSubmitBrowserCallback,
        onClose: () => closeAuthProgress(false),
        onCallbackUrlChange: setAuthCallbackUrl,
        onSubmitBrowserCallback: handleSubmitBrowserCallback,
        onConfirmCliInstall: handleConfirmCliInstall
      },
      import: {
        open: importModalVisible,
        importing: importingAccounts,
        canSubmit: canSubmitImport,
        mode: importMode,
        fileName: importFileName,
        pasteTemplate,
        importText,
        inputRef: importInputRef,
        folderInputRef: importFolderInputRef,
        onModeChange: handleImportModeChange,
        onTemplateChange: setPasteTemplate,
        onTextChange: setImportText,
        onFilesSelected: handleImportFilesSelected,
        onSubmit: handleImportSubmit,
        onCancel: closeImportModal
      },
      appInstall: {
        prompt: accountAppInstallPrompt,
        submitting: accountAppInstallSubmitting,
        result: accountAppInstallResult,
        onConfirm: confirmAccountAppInstall,
        onCancel: cancelAccountAppInstall,
        onOpenApp: openAppFromInstallResult,
        onRetry: retryAccountAppInstall,
        onCloseResult: () => setAccountAppInstallResult(null)
      },
      cliPicker: {
        account: cliPickerAccount,
        terminals: cliTerminals,
        selectedTerminalId: selectedCliTerminalId,
        loading: cliTerminalsLoading,
        workdir: cliWorkdir,
        workdirHistory: cliWorkdirHistory,
        onTerminalChange: setSelectedCliTerminalId,
        onWorkdirChange: setCliWorkdir,
        onClearWorkdirHistory: clearCliWorkdirHistory,
        onCancel: () => setCliPickerAccount(null),
        onOpen: openCliFromPicker,
        directoryPicker: cliDirectoryPicker
      },
      kimiDesktopLogin: {
        request: kimiDesktopLoginRequest,
        onClose: () => setKimiDesktopLoginRequest(null),
        onSuccess: () => {
          const request = kimiDesktopLoginRequest;
          setKimiDesktopLoginRequest(null);
          if (request?.openAfterLogin) void handleOpenApp(request.account, 'desktop');
        }
      },
      codexReset: {
        account: codexResetAccount,
        onClose: () => setCodexResetAccount(null),
        onAvailableCountChange: updateCodexResetAvailableCount
      },
      quotaResetHistory: {
        account: quotaResetHistoryAccount,
        onClose: () => setQuotaResetHistoryAccount(null)
      }
    }
  };
}

export type AccountActions = ReturnType<typeof useAccountActions>;
