import { writeClipboardText } from '@/utils/clipboard';
import React from 'react';
import { Form, Modal, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import {
  accountsAPI,
  modelsAPI,
  toolkitAPI,
  waitForAppInstallJob,
  resolveActiveServer
} from '@/services/api';
import type { AccountExportFormat, AccountImportUploadFile, PluginAccountLoginJob, ProviderAuthMethodSources, ProviderAuthSourceSummary, TokenConsumedEvent } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAppLaunchResponse,
  AccountAuthMode,
  AccountImportJob,
  AccountRefreshJob,
  AddAccountRequest,
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
  canEditAccountRoutingRules,
  canRestoreAccountScheduling,
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
import { desktopLoginRequiredAction } from '@/features/app-install/launch-required-action';
import type {
  UseAccountsSnapshotHandlers,
  UseAccountsSnapshotResult
} from '@/features/accounts/useAccountsSnapshot';
import type { UseModelCatalogResult } from '@/features/accounts/useModelCatalog';
import { getAuthJobIdentity, getCallbackUiCopy } from '@/features/accounts/AuthProgressModal';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import {
  confirmOccupiedAccountDeletion,
  isAccountOccupiedError
} from '@/features/accounts/account-deletion-confirm';
import { useServerDirectoryPicker } from '@/features/legacy-chat/use-server-directory-picker';
import { normalizeUpstreamErrorRulesForForm } from './upstream-error-mapping-presets';
import { getAuthOptionValue, splitAuthOptionValue } from '@/features/accounts/auth-option-value';
import { useWebTerminalManager } from '@/features/web-terminal/web-terminal-context';

// 账号页全部业务动作 —— 从 Accounts.tsx 抽取的状态与处理函数（添加 / 授权进度 / 重新认证 /
// 编辑凭据 / 导入导出 / 启停 / 默认账号 / 用量刷新 / 删除 / 打开 Desktop·CLI / 应用安装 …）。
// 桌面 Accounts.tsx 与移动端 MobileAccounts 共用同一套实现：同样的 API 调用、同样的守卫与提示文案。
// 业务弹窗统一由 AccountFlowModals 渲染（出口设置弹窗由页面自己渲染）。

// 不走登录任务、直接调注册接口的认证方式（与 handleAdd 的分支判定同源）：这些方式没有任务弹窗，
// 本机导入入口因此挂在添加账号弹窗上，而不是授权进度弹窗。
const DIRECT_REGISTER_AUTH_MODES: AccountAuthMode[] = ['api-key', 'auth-token', 'vertex-ai'];

const AUTH_JOB_FALLBACK_POLL_MS = 5000;
const ACCOUNT_REFRESH_FALLBACK_CLEAR_MS = 70_000;
// 刷新分支的中文名（与服务端 webui-account-refresh.js 的 BRANCH_LABELS 同口径）：
// 部分失败时用来告诉用户到底是哪一面没拿到。
const REFRESH_BRANCH_LABELS: Record<string, string> = {
  status: '状态',
  models: '模型',
  usage: '额度'
};
const CLI_WORKDIR_HISTORY_STORAGE_KEY = 'accounts-cli-workdir-history:v1';
const CLI_WORKDIR_HISTORY_LIMIT = 10;

function mapPluginLoginJob(job: PluginAccountLoginJob): AccountAddJob {
  const status = job.status === 'success'
    ? 'succeeded'
    : job.status === 'failed'
      ? 'failed'
      : job.status === 'cancelled'
        ? 'cancelled'
        : job.status === 'expired'
          ? 'expired'
          : 'running';
  return {
    id: job.jobId,
    provider: job.provider as Provider,
    accountRef: job.accountRef || '',
    authMode: job.authMode as AccountAuthMode,
    status,
    createdAt: Number(job.createdAt) || Date.now(),
    updatedAt: Number(job.updatedAt) || Date.now(),
    expiresAt: Number(job.expiresAt) || null,
    pollIntervalMs: Number(job.intervalMs) || null,
    exitCode: null,
    verificationUri: job.verificationUri || '',
    verificationUriComplete: job.verificationUriComplete || '',
    userCode: job.userCode || '',
    authorizationUrl: job.authorizationUrl || '',
    redirectUri: job.redirectUri || '',
    pluginLogin: true,
    sourceId: job.sourceId || '',
    canSubmit: job.canSubmit === true,
    submitLabel: job.submitLabel || '',
    submitPlaceholder: job.submitPlaceholder || '',
    logs: job.message || '',
    error: job.error || ''
  };
}

export type AccountAppInstallKind = 'desktop' | 'cli';

export interface AccountAppInstallPrompt {
  record: Account;
  kind: AccountAppInstallKind;
  terminalId?: string;
  workdir?: string;
  /** 跨 Provider 时缺的是 harness 的二进制，不是身份账号 Provider 的。 */
  harness?: string;
  model?: string;
  message: string;
}

function buildWebTerminalSessionKey(serverId: string, accountRef: string, harness: string, model: string, cwd: string): string {
  const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = [serverId, nonce, accountRef, harness, model, cwd].map((value) => String(value || '').trim()).join('|');
  // The server accepts printable keys only; URI encoding keeps paths such as
  // /workspace/foo and Windows drive letters unambiguous across refreshes.
  return `account-cli:${encodeURIComponent(raw).slice(0, 150)}`;
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
  serverRuntime?: boolean;
  /** openApp 请求成功返回后立即回调（页面据此提示账号出口未生效等附加信息）。 */
  onOpenAppResponse?: (result: AccountAppLaunchResponse) => void;
}

export function useAccountActions({
  snapshot,
  handlersRef,
  modelCatalog,
  loadAppEntries,
  serverRuntime = false,
  onOpenAppResponse
}: UseAccountActionsOptions) {
  const navigate = useNavigate();
  const webTerminalManager = useWebTerminalManager();
  const { setAccounts, requestAccountsSnapshotUpdate, stageAccountRemoval } = snapshot;
  const { clearModelAccountRefreshing, loadModelCatalog } = modelCatalog;
  const onOpenAppResponseRef = React.useRef(onOpenAppResponse);
  onOpenAppResponseRef.current = onOpenAppResponse;

  const [updatingStatusAccountRefs, setUpdatingStatusAccountRefs] = React.useState<Record<string, boolean>>({});
  const [refreshingUsageAccountRefs, setRefreshingUsageAccountRefs] = React.useState<Record<string, boolean>>({});
  const [refreshingAccountRefs, setRefreshingAccountRefs] = React.useState<Record<string, boolean>>({});
  const accountRefreshJobsRef = React.useRef<Map<string, AccountRefreshJob>>(new Map());
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
  // 认证来源链：任务运行期间解析「这个认证方式在这台机器上有哪些来源」，
  // 让弹窗能给出「从本机导入」而不是只让用户去拷文件。
  const [authLocalSources, setAuthLocalSources] = React.useState<ProviderAuthMethodSources | null>(null);
  const [authLocalImportSubmitting, setAuthLocalImportSubmitting] = React.useState(false);
  const [socialSubmitting, setSocialSubmitting] = React.useState(false);
  const [authLocalInstallSubmitting, setAuthLocalInstallSubmitting] = React.useState(false);
  const [authLocalScanSubmitting, setAuthLocalScanSubmitting] = React.useState(false);
  const [accountAppInstallPrompt, setAccountAppInstallPrompt] = React.useState<AccountAppInstallPrompt | null>(null);
  const [accountAppInstallSubmitting, setAccountAppInstallSubmitting] = React.useState(false);
  const [accountAppInstallResult, setAccountAppInstallResult] = React.useState<AccountAppInstallResult | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [editModalVisible, setEditModalVisible] = React.useState(false);
  const [editingAccount, setEditingAccount] = React.useState<Account | null>(null);
  const [routingRulesForm] = Form.useForm();
  const [routingRulesAccount, setRoutingRulesAccount] = React.useState<Account | null>(null);
  const [routingRulesSubmitting, setRoutingRulesSubmitting] = React.useState(false);
  const [importModalVisible, setImportModalVisible] = React.useState(false);
  const [importMode, setImportMode] = React.useState<ImportMode>('file');
  const [pasteTemplate, setPasteTemplate] = React.useState<PasteTemplate>('jsonl');
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
  const [accountWindowActivationAccount, setAccountWindowActivationAccount] = React.useState<Account | null>(null);
  const [cliTerminals, setCliTerminals] = React.useState<ClientTerminalItem[]>([]);
  const [selectedCliTerminalId, setSelectedCliTerminalId] = React.useState('system-default');
  const [cliTerminalsLoading, setCliTerminalsLoading] = React.useState(false);
  const [cliHomeDir, setCliHomeDir] = React.useState('');
  const [cliWorkdir, setCliWorkdir] = React.useState('');
  const [cliWorkdirHistory, setCliWorkdirHistory] = React.useState<string[]>(readCliWorkdirHistory);
  const [cliPickerHarnesses, setCliPickerHarnesses] = React.useState<Array<{ id: string; label: string }>>([]);
  const [selectedCliHarness, setSelectedCliHarness] = React.useState('');
  const [cliPickerModels, setCliPickerModels] = React.useState<string[]>([]);
  const [cliPickerModelLabels, setCliPickerModelLabels] = React.useState<Record<string, string>>({});
  const [cliPickerDefaultModel, setCliPickerDefaultModel] = React.useState('');
  const [selectedCliModel, setSelectedCliModel] = React.useState('');
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
  const addFormAuthSelection = splitAuthOptionValue(Form.useWatch('authMode', form));
  const addFormAuthMode = addFormAuthSelection.authMode;
  // 添加账号弹窗里的「从本机导入」：来源由服务端来源链解析（可用 + directImport），这里只持有结果。
  const [addLocalImportSource, setAddLocalImportSource] = React.useState<ProviderAuthSourceSummary | null>(null);
  const [addLocalImportSubmitting, setAddLocalImportSubmitting] = React.useState(false);
  const [addPluginLoginSource, setAddPluginLoginSource] = React.useState<ProviderAuthSourceSummary | null>(null);
  const [addPluginLoginSubmitting, setAddPluginLoginSubmitting] = React.useState(false);
  const [pluginLoginJobId, setPluginLoginJobId] = React.useState<string | null>(null);
  const [pluginLoginSubmitValue, setPluginLoginSubmitValue] = React.useState('');
  const [pluginLoginSubmitSubmitting, setPluginLoginSubmitSubmitting] = React.useState(false);
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
      await writeClipboardText(text);
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
    setPluginLoginJobId(null);
    setAddJob(null);
    setAuthFlowKind('add');
    setAuthSubjectLabel('');
    setAuthCallbackUrl('');
    setAuthCallbackSubmitting(false);
    setPluginLoginSubmitValue('');
    setPluginLoginSubmitSubmitting(false);
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

  const handleExport = async (format: AccountExportFormat = 'cliproxyapi') => {
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
      baseUrl: record.baseUrl || '',
      upstreamErrorRules: normalizeUpstreamErrorRulesForForm(record.upstreamErrorRules),
      upstreamErrorGroupIds: record.upstreamErrorGroupIds || [],
      clearErrorBlock: false
    });
    setEditModalVisible(true);
  };

  const handleEditSubmit = async (): Promise<boolean> => {
    try {
      const values = await editForm.validateFields();
      if (!editingAccount) return false;
      setSubmitting(true);
      // 官方地址账号不提交规则字段：既让服务端的「官方地址不接受规则」守卫不被空数组
      // 触发，也避免保存配置时顺手删掉账号上的历史规则。
      const routingRulesEditable = canEditAccountRoutingRules(editingAccount);
      const res = await accountsAPI.updateAccount(editingAccount.provider, editingAccount.accountRef, {
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        ...(routingRulesEditable
          ? {
              upstreamErrorRules: values.upstreamErrorRules || [],
              upstreamErrorGroupIds: values.upstreamErrorGroupIds || []
            }
          : {}),
        clearErrorBlock: values.clearErrorBlock === true,
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

  const handleRestoreScheduling = (record: Account) => {
    if (!canRestoreAccountScheduling(record)) return;
    Modal.confirm({
      title: '强制恢复调度？',
      content: '将清空该账号的运行态阻塞（余额/权限/额度/冷却与模型级冷却），让它立刻重新参与调度。仅在你已确认上游条件恢复时使用。',
      okText: '恢复调度',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await accountsAPI.restoreScheduling(record.provider, record.accountRef);
          message.success('已恢复调度');
          setAccounts((prev) => mergeSingleAccount(prev, res.account));
        } catch (error: any) {
          message.error(error?.response?.data?.message || '恢复调度失败');
        }
      }
    });
  };

  const handleRoutingRules = (record: Account) => {
    if (!canEditAccountRoutingRules(record)) {
      message.warning('调度规则只用于第三方/自建上游：官方地址与登录态账号返回厂商标准错误码。');
      return;
    }
    setRoutingRulesAccount(record);
    routingRulesForm.setFieldsValue({
      upstreamErrorRules: normalizeUpstreamErrorRulesForForm(record.upstreamErrorRules),
      upstreamErrorGroupIds: record.upstreamErrorGroupIds || [],
      clearErrorBlock: false
    });
  };

  const handleRoutingRulesSubmit = async (): Promise<boolean> => {
    try {
      const values = await routingRulesForm.validateFields();
      if (!routingRulesAccount) return false;
      setRoutingRulesSubmitting(true);
      const res = await accountsAPI.updateAccountRoutingRules(routingRulesAccount.provider, routingRulesAccount.accountRef, {
        upstreamErrorRules: values.upstreamErrorRules || [],
        upstreamErrorGroupIds: values.upstreamErrorGroupIds || [],
        clearErrorBlock: values.clearErrorBlock === true
      });
      if (!res.ok) return false;
      message.success('调度规则已更新');
      setAccounts((prev) => mergeSingleAccount(prev, res.account));
      setRoutingRulesAccount(null);
      return true;
    } catch (error: any) {
      if (error?.errorFields) return false;
      message.error(error?.response?.data?.message || '调度规则更新失败');
      return false;
    } finally {
      setRoutingRulesSubmitting(false);
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
    if (job.scope === 'account') {
      const previous = accountRefreshJobsRef.current.get(accountRef);
      // 接受响应和推送可能乱序到达；同一作业终态不会被 queued/running 覆盖。
      if (previous?.id === jobId && (previous.status === 'succeeded' || previous.status === 'failed')) return;
      accountRefreshJobsRef.current.set(accountRef, job);
      const active = job.status === 'queued' || job.status === 'running';
      setRefreshingAccountRefs((current) => {
        const next = { ...current };
        if (active) next[accountRef] = true;
        else delete next[accountRef];
        return next;
      });
      if (!active) {
        // 部分失败（failedBranches 非空但作业成功）不能笼统报「刷新失败」：其它面已经
        // 刷新成功，报失败会让用户以为整次刷新白做。说清是哪一面没拿到。
        const failedLabels = (job.failedBranches || [])
          .map((name) => REFRESH_BRANCH_LABELS[name] || name)
          .filter(Boolean);
        if (job.status === 'failed') message.warning(job.error || '账号刷新失败');
        else if (failedLabels.length > 0) message.warning(`已刷新，但${failedLabels.join('、')}未成功`);
        else if (job.recovered === true) message.success('账号已刷新，轻探测成功，已自动恢复调度');
        else message.success('账号已刷新');
      }
      return;
    }
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
      accountRefreshJobsRef.current.delete(accountRef);
      setRefreshingAccountRefs((current) => {
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

  // 外部账号插件的登录任务：独立轮询入口，成功/失败都走同一套进度弹窗。
  React.useEffect(() => {
    if (!pluginLoginJobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const pluginJob = await accountsAPI.getPluginLoginJob(pluginLoginJobId);
        if (cancelled) return;
        const job = mapPluginLoginJob(pluginJob);
        setAddJob(job);
        if (job.status === 'running') return;
        setPluginLoginJobId(null);
        if (job.status === 'succeeded') {
          setAuthSuccessClosing(true);
          message.success('插件登录完成');
          void requestAccountsSnapshotUpdate({ failureMessage: '刷新账号列表失败' });
          if (successAutoCloseTimerRef.current !== null) {
            window.clearTimeout(successAutoCloseTimerRef.current);
          }
          successAutoCloseTimerRef.current = window.setTimeout(() => {
            closeAuthProgressPanel();
          }, 3000);
        } else if (job.status === 'failed') {
          message.error(job.error || '插件登录失败');
        }
      } catch (_error) {
        if (!cancelled) setPluginLoginJobId(null);
      }
    };

    void poll();
    timer = setInterval(poll, AUTH_JOB_FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [pluginLoginJobId, closeAuthProgressPanel, requestAccountsSnapshotUpdate]);

  // 认证来源链：任务运行期间解析一次「这个认证方式在这台机器上有哪些来源」。
  // 界面只消费解析结果（本机来源是否可用 / 是否可安装），不自己判断有没有装 IDE。
  const refreshAuthLocalSources = React.useCallback(async (job: AccountAddJob | null) => {
    if (!job || !job.provider || !job.authMode) return;
    try {
      const response = await accountsAPI.listProviderAuthSources(job.provider);
      if (!response || !response.ok) return;
      setAuthLocalSources((response.methods || []).find((item) => item.authMode === job.authMode) || null);
    } catch (_error) {
      // 解析失败只意味着「不展示本机导入」，不影响粘贴等兜底路径。
      setAuthLocalSources(null);
    }
  }, []);

  React.useEffect(() => {
    if (!addJob || addJob.status !== 'running' || !addJob.provider || !addJob.authMode) {
      setAuthLocalSources(null);
      return undefined;
    }
    let cancelled = false;
    void refreshAuthLocalSources(addJob).then(() => { if (cancelled) setAuthLocalSources(null); });
    return () => { cancelled = true; };
  }, [addJob?.provider, addJob?.authMode, addJob?.status, refreshAuthLocalSources]);

  /**
   * 装客户端后就能一键导入（安装通道复用既有 Toolkit 应用安装，装完自动重解析来源）。
   */
  const handleInstallLocalClient = async (kind: 'desktop' | 'cli' = 'desktop') => {
    if (!addJob || !addJob.provider) return;
    setAuthLocalInstallSubmitting(true);
    try {
      const appId = kind === 'desktop' ? `${addJob.provider}-desktop` : addJob.provider;
      const response = await toolkitAPI.executeAppAction(appId, 'install', kind);
      if (!response.ok || !response.job) {
        throw new Error(response.error || '未创建安装任务');
      }
      message.info('已开始安装，完成后即可从本机导入');
      const finished = await waitForAppInstallJob(response.job.id);
      if (finished && finished.status === 'succeeded') {
        message.success('安装完成');
        await refreshAuthLocalSources(addJob);
      } else {
        message.warning('安装未完成，可在 Toolkit › 应用管理查看进度');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '安装失败');
    } finally {
      setAuthLocalInstallSubmitting(false);
    }
  };

  /** 扫描来源（handler = host-account-scan）：复用既有「扫描本机账号」，扫描后重解析来源。 */
  const handleScanHostAccounts = async () => {
    if (!addJob) return;
    setAuthLocalScanSubmitting(true);
    try {
      const result = await accountsAPI.detectHostAccounts();
      const registered = Array.isArray(result?.registered) ? result.registered.length : 0;
      if (result?.ok === false) {
        message.error('扫描本机账号失败');
        return;
      }
      message.success(registered > 0 ? `扫描完成：新增/更新 ${registered} 个账号` : '扫描完成：没有新增账号');
      await refreshAuthLocalSources(addJob);
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '扫描本机账号失败');
    } finally {
      setAuthLocalScanSubmitting(false);
    }
  };

  /**
   * 切到 social（Google / Github）设备流。
   *
   * 为什么是「重开一个任务」而不是在同一个任务里换：两条设备流是**两套协议**
   * （Builder ID 走 AWS SSO OIDC，social 走 Kiro 自己的认证服务），设备码不通用。
   * 服务端按 loginProvider 选协议，因此这里取消旧任务后按同一 authMode 重新发起。
   */
  const handleStartSocialDevice = async (loginProvider: 'Google' | 'Github') => {
    if (!addJob || addJob.status !== 'running') return;
    setSocialSubmitting(true);
    try {
      const result = await accountsAPI.add({
        provider: addJob.provider as Provider,
        authMode: addJob.authMode as AccountAuthMode,
        config: { loginProvider },
        replaceExisting: true
      } as AddAccountRequest);
      if (result.jobId) {
        openAuthProgressFromResult(result, 'add', 'OAuth 授权');
        message.info(`已切换到 ${loginProvider} 设备流，请按新验证码完成授权`);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || `切换到 ${loginProvider} 登录失败`);
    } finally {
      setSocialSubmitting(false);
    }
  };

  /** 从本机登录态完成登录任务（例如 Kiro IDE 已登录时一键导入）。 */
  const handleLocalAuthImport = async (sourceId: string) => {
    if (!addJob || addJob.status !== 'running' || addJob.pluginLogin || !sourceId) return;
    setAuthLocalImportSubmitting(true);
    try {
      const job = await accountsAPI.completeLocalAuthImport(addJob.id, sourceId);
      setAddJob(job);
      message.success('已从本机导入登录态');
    } catch (error: any) {
      if (error?.response?.data?.job) {
        setAddJob(error.response.data.job);
        if (error.response.data.job.status !== 'running') setAddJobId(null);
      }
      message.error(error?.response?.data?.error || '从本机导入失败');
    } finally {
      setAuthLocalImportSubmitting(false);
    }
  };

  React.useEffect(() => {
    if (!selectedProvider) {
      previousAddProviderRef.current = undefined;
      form.setFieldValue('authMode', undefined);
      return;
    }
    if (previousAddProviderRef.current === selectedProvider) return;
    previousAddProviderRef.current = selectedProvider;
    const availableOptions = PROVIDER_AUTH_OPTIONS[selectedProvider] || [];
    const firstActiveMode = availableOptions.find((opt) => !opt.disabled) || availableOptions[0];
    const firstActiveValue = firstActiveMode ? getAuthOptionValue(firstActiveMode) : undefined;
    form.setFieldValue('authMode', firstActiveValue);
  }, [form, selectedProvider]);

  /**
   * 添加账号弹窗里的「从本机导入」。
   *
   * 走登录任务的认证方式，导入入口在任务弹窗里（同一动作不给两个入口）；**不经过登录任务**的
   * 认证方式（直接调注册接口的那些）没有任何弹窗可承载，所以选完供应商/认证方式就在这里给一键导入
   * ——例如只有 api-key 的 provider，本机登录态本来就是完整投影。
   * 该给不给由服务端来源链决定（`available` + `directImport`），界面不判断 provider 名。
   */
  React.useEffect(() => {
    if (!modalVisible || !selectedProvider || !addFormAuthMode) {
      setAddLocalImportSource(null);
      setAddPluginLoginSource(null);
      return undefined;
    }
    let cancelled = false;
    void accountsAPI.listProviderAuthSources(selectedProvider)
      .then((response) => {
        if (cancelled) return;
        const methods = (response && response.methods) || [];
        const method = methods.find((item) => item.authMode === addFormAuthMode) || null;
        const sources = (method && method.sources) || [];
        const preferred = sources.find((item) => item.id === (method && method.preferredSourceId)) || null;
        const usable = DIRECT_REGISTER_AUTH_MODES.includes(addFormAuthMode)
          ? (preferred && preferred.available && preferred.directImport
            ? preferred
            : sources.find((item) => item.available && item.directImport) || null)
          : null;
        const pluginSource = preferred && preferred.available && preferred.pluginLogin
          ? preferred
          : sources.find((item) => item.available && item.pluginLogin) || null;
        setAddLocalImportSource(usable);
        setAddPluginLoginSource(pluginSource);
      })
      .catch(() => {
        // 解析失败只意味着「不展示本机/插件入口」，粘贴 key 的路径照常可用。
        if (!cancelled) {
          setAddLocalImportSource(null);
          setAddPluginLoginSource(null);
        }
      });
    return () => { cancelled = true; };
  }, [modalVisible, selectedProvider, addFormAuthMode]);

  /** 从本机登录态直接建账号（不开登录任务）。 */
  const handleAddLocalImport = async () => {
    const source = addLocalImportSource;
    if (!source || !selectedProvider) return;
    setAddLocalImportSubmitting(true);
    try {
      const aliasPoolParticipates = form.getFieldValue('aliasPoolParticipates') !== false;
      await accountsAPI.importLocalAuthSource(selectedProvider, source.id, { aliasPoolParticipates });
      message.success('已从本机登录态建账号');
      closeAddAccountModal();
      await requestAccountsSnapshotUpdate({ failureMessage: '刷新账号列表失败' });
    } catch (error: any) {
      const code = error?.response?.data?.error || '';
      if (code === 'auth_source_already_imported') {
        message.info('该本机登录态已经在账号池里了');
      } else if (code === 'auth_source_requires_login_job') {
        message.warning('该来源需要走登录流程，请改用对应的认证方式');
      } else {
        message.error(error?.response?.data?.message || (code ? `从本机导入失败：${code}` : '从本机导入失败'));
      }
    } finally {
      setAddLocalImportSubmitting(false);
    }
  };

  /** 外部账号插件登录（P4）：任务与投影由宿主托管，这里只消费公开状态。 */
  const handleAddPluginLogin = async () => {
    const source = addPluginLoginSource;
    if (!source || !selectedProvider) return;
    setAddPluginLoginSubmitting(true);
    try {
      const pluginJob = await accountsAPI.startPluginLogin(selectedProvider, source.id);
      const job = mapPluginLoginJob(pluginJob);
      setAuthSuccessClosing(false);
      setAuthFlowKind('add');
      setAuthSubjectLabel(source.description || '插件登录');
      setAuthCallbackUrl('');
      setAuthCallbackSubmitting(false);
      setPluginLoginSubmitValue('');
      setPluginLoginSubmitSubmitting(false);
      // 插件任务没有内置回调/粘贴入口，来源卡片也不应由内置链路承接。
      setAuthLocalSources(null);
      setAddJob(job);
      setAddJobId(null);
      setPluginLoginJobId(job.status === 'running' ? job.id : null);
      setAuthProgressVisible(true);
      closeAddAccountModal();
    } catch (error: any) {
      const code = error?.response?.data?.error || '';
      message.error(error?.response?.data?.detail || (code ? `插件登录启动失败：${code}` : '插件登录启动失败'));
    } finally {
      setAddPluginLoginSubmitting(false);
    }
  };

  /**
   * 插件登录的粘贴/回调通道：服务端只把值转交给插件，不落任务文件。
   * 成功后与轮询路径走同一套收尾（刷新运行池、自动关闭进度弹窗）。
   */
  const handleSubmitPluginLogin = async () => {
    const jobId = pluginLoginJobId || (addJob?.pluginLogin ? addJob.id : '');
    if (!jobId || !addJob?.canSubmit) return;
    const value = pluginLoginSubmitValue.trim();
    if (!value) {
      message.warning('请先粘贴授权码或凭据');
      return;
    }
    setPluginLoginSubmitSubmitting(true);
    try {
      const result = await accountsAPI.submitPluginLogin(jobId, value);
      const job = mapPluginLoginJob(result.job);
      setAddJob(job);
      setPluginLoginSubmitValue('');
      if (job.status === 'running') return;
      setPluginLoginJobId(null);
      if (job.status === 'succeeded') {
        setAuthSuccessClosing(true);
        message.success('插件登录完成');
        void requestAccountsSnapshotUpdate({ failureMessage: '刷新账号列表失败' });
        if (successAutoCloseTimerRef.current !== null) {
          window.clearTimeout(successAutoCloseTimerRef.current);
        }
        successAutoCloseTimerRef.current = window.setTimeout(() => {
          closeAuthProgressPanel();
        }, 3000);
      } else if (job.status === 'failed') {
        message.error(job.error || '插件登录失败');
      }
    } catch (error: any) {
      const code = error?.response?.data?.error || '';
      message.error(error?.response?.data?.detail || (code ? `插件登录提交失败：${code}` : '插件登录提交失败'));
    } finally {
      setPluginLoginSubmitSubmitting(false);
    }
  };

  const closeAuthProgress = async (forceCancel = false) => {
    if (authSuccessClosing) return;
    if (addJob && addJob.status === 'running') {
      const pluginManaged = Boolean(pluginLoginJobId && addJob.id === pluginLoginJobId);
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
        if (pluginManaged) await accountsAPI.cancelPluginLoginJob(addJob.id);
        else await accountsAPI.cancelAddJob(addJob.id);
        setPluginLoginJobId(null);
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
    authStrategy?: string;
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
    setPluginLoginJobId(null);
    setAddJob({
      id: result.jobId,
      provider: result.provider,
      accountRef: result.accountRef,
      authMode: result.authMode,
      authStrategy: result.authStrategy,
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
    setPluginLoginJobId(null);
    setAddJob(job);
    setAddJobId(job.status === 'running' ? jobId : null);
    setAuthProgressVisible(true);
    message.warning(fallbackMessage);
  }, []);

  const handleSubmitBrowserCallback = async () => {
    if (!addJob || addJob.status !== 'running' || addJob.pluginLogin) return;
    const copy = getCallbackUiCopy(addJob.provider, addJob.authStrategy);
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
    if (!addJob || addJob.status !== 'running' || addJob.pluginLogin) return false;
    if (!authCallbackUrl.trim()) return false;
    if (!getCallbackUiCopy(addJob.provider, addJob.authStrategy).requiresAwaitingCode) return true;
    return addJob.authProgressState === 'awaiting_code';
  }, [addJob, authCallbackUrl]);

  const handleConfirmCliInstall = async () => {
    if (!addJob?.id || addJob.pluginLogin) return;
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
    const selectedAuth = splitAuthOptionValue(values.authMode);
    if (selectedAuth.authMode === 'api-key' || selectedAuth.authMode === 'auth-token') {
      configPayload = {
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        credentialType: selectedAuth.authMode
      };
    } else if (selectedAuth.authMode === 'vertex-ai') {
      configPayload = {
        projectId: values.projectId,
        location: values.location,
        apiKey: values.apiKey
      };
    }
    const requestPayload = {
      provider: values.provider as Provider,
      authMode: selectedAuth.authMode as AccountAuthMode,
      ...(selectedAuth.authStrategy ? { authStrategy: selectedAuth.authStrategy } : {}),
      config: configPayload,
      // 缺省＝参与；只有用户显式关掉才传 false（服务端建账号后立即落账号级偏好）。
      aliasPoolParticipates: values.aliasPoolParticipates !== false
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

  const handleDelete = async (provider: string, accountRef: string, options?: { force?: boolean }) => {
    try {
      await accountsAPI.delete(provider, accountRef, options);
      stageAccountRemoval({ accountRef });
      message.success('删除账号成功');
      return;
    } catch (error: any) {
      const data = error?.response?.data;
      // 被占用不是「失败」，而是「需要用户决定」：把后端如实报出的占用者列出来，
      // 确认后带 force 重发，由后端终止它们再删。这样用户不必自己去猜是谁占着。
      if (isAccountOccupiedError(data)) {
        confirmOccupiedAccountDeletion({
          data,
          onConfirm: () => handleDelete(provider, accountRef, { force: true })
        });
        return;
      }
      message.error(data?.message || '删除账号失败');
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

  const handleRefreshAccount = async (record: Account) => {
    const accountRef = getAccountRef(record);
    if (refreshingAccountRefs[accountRef]) return;
    setRefreshingAccountRefs((current) => ({ ...current, [accountRef]: true }));
    try {
      const result = await accountsAPI.refresh(record.provider, accountRef);
      handleAccountRefreshJobUpdate(result.job);
    } catch (error: any) {
      setRefreshingAccountRefs((current) => {
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
      if (error?.response?.status === 404) {
        stageAccountRemoval(record);
        message.warning('账号已不存在，已从列表移除');
      } else {
        message.error(error?.response?.data?.message || '刷新账号失败');
      }
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

  const handleOpenApp = async (
    record: Account,
    kind: 'desktop' | 'cli',
    terminalId?: string,
    workdir?: string,
    options?: { harness?: string; model?: string; transport?: 'webui' | 'native'; sessionKey?: string }
  ): Promise<boolean> => {
    const launchOptions = kind === 'cli' ? options : undefined;
    try {
      const result = await accountsAPI.openApp(
        record.provider,
        record.accountRef,
        kind,
        'open',
        terminalId,
        workdir,
        // 非本机 Server（远端 profile，或 Server 无桌面）一律 Web Terminal；本机的最终判定
        // 由 Server 按请求来源再做一次（局域网/代理访问也会被改成 webui-pty）。
        kind === 'cli' && (serverRuntime || resolveActiveServer().isRemote)
          ? { ...launchOptions, transport: 'webui', sessionKey: launchOptions?.sessionKey || buildWebTerminalSessionKey(
            resolveActiveServer().serverId || 'local',
            record.accountRef,
            launchOptions?.harness || record.provider,
            launchOptions?.model || '',
            workdir || cliHomeDir
          ) }
          : (kind === 'cli' ? { ...launchOptions, transport: 'native' } : launchOptions)
      );
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
      const openedWebTerminal = kind === 'cli' && result.launchMode === 'webui-pty';
      message.success(kind === 'desktop' ? '已打开 Desktop 应用' : (openedWebTerminal ? '已打开 Server Web 终端' : '已打开 CLI 终端'));
      if (openedWebTerminal) {
        const key = String(result.sessionKey || launchOptions?.sessionKey || '').trim();
        if (key) {
          webTerminalManager.openTab({
            sessionKey: key,
            cwd: String(workdir || cliHomeDir || '').trim(),
            harness: String(launchOptions?.harness || record.provider),
            model: String(launchOptions?.model || ''),
            kind: 'account-cli',
            label: String(result.sessionTitle || `${launchOptions?.harness || record.provider} · ${getAccountPrimaryLabel(record)}`)
          });
        }
      }
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
          harness: launchOptions?.harness,
          model: launchOptions?.model,
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
      const loginAction = kind === 'desktop' ? desktopLoginRequiredAction(error) : null;
      if (loginAction) {
        setKimiDesktopLoginRequest({ account: record, openAfterLogin: true });
        if (loginAction.warn) message.warning(loginAction.message || '登录态需要重新托管');
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
      const appId = prompt.kind === 'desktop'
        ? `${prompt.record.provider}-desktop`
        : (prompt.harness || prompt.record.provider);
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
    void handleOpenApp(
      result.prompt.record,
      result.prompt.kind,
      result.prompt.terminalId,
      result.prompt.workdir,
      { harness: result.prompt.harness, model: result.prompt.model }
    );
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
      // 三个数据面并行读取：终端、已安装的 harness、身份账号的模型目录。
      // 任一副数据失败都不拦终端选择；跨 Provider 的模型缺失会由弹窗提示。
      const [terminalsResult, entriesResult, catalogResult] = await Promise.allSettled([
        accountsAPI.listTerminals(),
        accountsAPI.listAppEntries(),
        modelsAPI.listCatalog()
      ]);
      if (!serverRuntime && terminalsResult.status !== 'fulfilled') throw terminalsResult.reason;
      const response = terminalsResult.status === 'fulfilled' ? terminalsResult.value : { terminals: [], homeDir: '' };
      const available = serverRuntime ? [] : (response.terminals || []).filter((terminal) => terminal.installed);
      if (!serverRuntime && !available.length) {
        message.info('当前主机没有可用终端，请到 Toolkit > 终端管理安装。');
        return;
      }
      const installed = entriesResult.status === 'fulfilled' ? entriesResult.value : null;
      const capabilities = installed?.capabilities || {};
      const entryState = installed?.entries || {};
      // harness 与账号身份解耦：列出所有合同声明支持 CLI 的 harness（未安装也列出，
      // 选中后由 open-app 的 install_required 流程自动安装）；账号 Provider 的原生
      // CLI 可用时排第一，否则默认使用第一个 harness。
      const supportedIds = Object.keys(capabilities)
        .filter((id) => capabilities[id]?.cli !== false
          && (id === record.provider || capabilities[id]?.crossProviderHarness === true));
      const harnessIds = supportedIds.length ? supportedIds : [record.provider];
      const harnesses = harnessIds
        .map((id) => {
          // 外部 harness（Pi/DSH）没有 provider 目录条目，显示名由能力描述符直接下发；
          // 原生 harness 仍用 provider 的展示名（例如 codex → ChatGPT）。
          const name = String(
            capabilities[id]?.label
            || providerNames[id as keyof typeof providerNames]
            || id
          );
          const cliInstalled = entryState[id]?.cli === true;
          return { id, label: cliInstalled ? name : `${name}（未安装）` };
        })
        .sort((a, b) => {
          if (a.id === record.provider) return -1;
          if (b.id === record.provider) return 1;
          return a.label.localeCompare(b.label);
        });
      if (!harnesses.length) {
        message.info('当前主机没有支持的 CLI harness，请到 Toolkit > 应用管理检查。');
        return;
      }

      const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
      const accountRef = getAccountRef(record);
      const models = [...new Set(
        (catalog?.selectableByAccountRef?.[accountRef]
          || catalog?.byAccountRef?.[accountRef]
          || catalog?.models?.[record.provider]
          || []).map((item) => String(item || '').trim()).filter(Boolean)
      )];
      const modelLabels = catalog?.labels?.[record.provider] || {};
      const defaultModel = String(catalog?.defaultByAccountRef?.[accountRef] || '').trim();
      const defaultHarness = harnesses[0].id;

      setCliTerminals(available);
      setSelectedCliTerminalId(available.find((terminal) => terminal.default)?.id || available[0]?.id || 'server-webui');
      const homeDir = String(response.homeDir || '').trim();
      setCliHomeDir(homeDir);
      setCliWorkdir(homeDir);
      setCliPickerHarnesses(harnesses);
      setSelectedCliHarness(defaultHarness);
      setCliPickerModels(models);
      setCliPickerModelLabels(modelLabels);
      setCliPickerDefaultModel(defaultModel);
      // 跨 Provider 默认必须带一个身份账号支持的模型；同 Provider 跟随 harness 默认。
      setSelectedCliModel(defaultHarness !== record.provider ? (defaultModel || models[0] || '') : '');
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

  const handleCliHarnessChange = (harness: string) => {
    setSelectedCliHarness(harness);
    const crossProvider = Boolean(cliPickerAccount && harness !== cliPickerAccount.provider);
    if (crossProvider && !selectedCliModel) {
      // 跨 Provider 不能跟随 harness 自己的默认模型（那通常是它自己 Provider 的模型，
      // 在身份账号的目录里不存在）。优先用账号默认模型，否则用目录第一项。
      setSelectedCliModel(cliPickerDefaultModel || cliPickerModels[0] || '');
    }
  };

  const openCliFromPicker = (
    account: Account,
    terminalId: string,
    workdir: string,
    harness: string,
    model: string
  ) => {
    setCliPickerAccount(null);
    void handleOpenApp(account, 'cli', terminalId, workdir || undefined, {
      harness,
      model: model || undefined
    }).then((opened) => {
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
    serverRuntime,
    // 行级状态
    updatingStatusAccountRefs,
    refreshingUsageAccountRefs,
    refreshingAccountRefs,
    // 行级操作
    copyAccountEmail,
    handleEdit,
    handleRoutingRules,
    handleRestoreScheduling,
    handleReauth,
    confirmDeleteAccount,
    handleReload,
    handleToggleStatus,
    handleSetDefault,
    handleSetMobile,
    handleRefreshUsage,
    handleRefreshAccount,
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
    accountWindowActivationAccount,
    setAccountWindowActivationAccount,
    // AccountFlowModals 使用的弹窗状态与回调
    modals: {
      add: {
        open: modalVisible,
        form,
        submitting,
        onSubmit: handleAdd,
        onCancel: closeAddAccountModal,
        // 非 null 时弹窗渲染「从本机导入」行（来源可用且能直接提交，例如只有 api-key 的 provider）。
        localImport: addLocalImportSource ? {
          sourceId: addLocalImportSource.id,
          description: addLocalImportSource.description,
          submitting: addLocalImportSubmitting,
          onImport: handleAddLocalImport
        } : null,
        pluginLogin: addPluginLoginSource ? {
          sourceId: addPluginLoginSource.id,
          description: addPluginLoginSource.description,
          submitting: addPluginLoginSubmitting,
          onLogin: handleAddPluginLogin
        } : null
      },
      edit: {
        open: editModalVisible,
        form: editForm,
        isClaudeCredential: isEditingClaudeCredential,
        provider: editingAccount?.provider,
        // 调度规则编辑器只对第三方/自建上游的 API Key 账号渲染：官方地址账号没有可对齐
        // 的错误码，渲染出来就等于给了一条注定不命中的流程。
        showRoutingRules: editingAccount ? canEditAccountRoutingRules(editingAccount) : false,
        effectiveAuthMode: effectiveEditAuthMode,
        credentialModeChanged: isEditCredentialModeChanged,
        onClose: () => setEditModalVisible(false),
        onSubmit: handleEditSubmit
      },
      routingRules: {
        account: routingRulesAccount,
        form: routingRulesForm,
        submitting: routingRulesSubmitting,
        onClose: () => setRoutingRulesAccount(null),
        onSubmit: handleRoutingRulesSubmit
      },
      authProgress: {
        open: authProgressVisible,
        job: addJob,
        subjectLabel: authSubjectLabel,
        successClosing: authSuccessClosing,
        callbackUrl: authCallbackUrl,
        callbackSubmitting: authCallbackSubmitting,
        pluginLoginSubmitValue,
        pluginLoginSubmitSubmitting,
        cliInstallSubmitting,
        canSubmitCallback: canSubmitBrowserCallback,
        authSources: authLocalSources,
        localImportSubmitting: authLocalImportSubmitting,
        localInstallSubmitting: authLocalInstallSubmitting,
        localScanSubmitting: authLocalScanSubmitting,
        socialSubmitting,
        onLocalImport: handleLocalAuthImport,
        onInstallLocalClient: handleInstallLocalClient,
        onScanHostAccounts: handleScanHostAccounts,
        onStartSocialDevice: handleStartSocialDevice,
        onClose: () => closeAuthProgress(false),
        onCallbackUrlChange: setAuthCallbackUrl,
        onSubmitBrowserCallback: handleSubmitBrowserCallback,
        onPluginLoginSubmitValueChange: setPluginLoginSubmitValue,
        onSubmitPluginLogin: handleSubmitPluginLogin,
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
        harnesses: cliPickerHarnesses,
        selectedHarness: selectedCliHarness,
        models: cliPickerModels,
        modelLabels: cliPickerModelLabels,
        selectedModel: selectedCliModel,
        defaultModel: cliPickerDefaultModel,
        onHarnessChange: handleCliHarnessChange,
        onModelChange: setSelectedCliModel,
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
