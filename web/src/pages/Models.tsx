import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './Models.css';
import { Alert, Form, Input, Modal, Segmented, Select, Space, Switch, Tag, Tooltip, Typography, message, Grid } from 'antd';
import { ApiOutlined, ArrowLeftOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { modelsAPI } from '@/services/api';
import type {
  ManagedOpenAIModelItem,
  OpenAIModelItem,
  Provider,
  WebUiOpenAIModelAccount,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse
} from '@/types';
import Button from '@/components/ui/AppButton';
import DataToolbar from '@/components/ui/DataToolbar';
import PaginatedList from '@/components/ui/PaginatedList';
import { ModalForm, StatisticCard } from '@ant-design/pro-components';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import { parseUpstreamError } from '@/utils/format-upstream-error';
import { openExternalUrl } from '@/services/open-external-url';

type ProviderFilter = Provider | 'all';
type AccountFilter = string | 'all';
type ModelStatusFilter = 'all' | 'enabled' | 'disabled' | 'manual';

type GlobalModelAccount = {
  key: string;
  label: string;
  model: ManagedOpenAIModelItem;
};

type GlobalModelRow = OpenAIModelItem & {
  accountModels: ManagedOpenAIModelItem[];
  accounts: GlobalModelAccount[];
  providers: Provider[];
  enabledCount: number;
  disabledCount: number;
  manualCount: number;
  visible: boolean;
};

const PROVIDERS: Provider[] = providerIds;
const IGNORABLE_MODEL_PROBE_ERRORS = ['operation was aborted', 'aborterror'];

function formatUpdatedAt(value?: number) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚未刷新';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isIgnorableModelProbeError(error?: string) {
  const normalized = String(error || '').trim().toLowerCase();
  return IGNORABLE_MODEL_PROBE_ERRORS.some((pattern) => normalized.includes(pattern));
}

function getVisibleModelProbeError(catalog: WebUiOpenAIModelsResponse | null) {
  if (!catalog) return '';
  const candidates = [catalog.firstError, ...Object.values(catalog.errorsByAccountRef || {})];
  return candidates.find((error) => error && !isIgnorableModelProbeError(error)) || '';
}

function isCatalogJobActive(job: WebUiOpenAIModelsJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function formatCatalogJobStatus(job: WebUiOpenAIModelsJob | null) {
  if (!job) return '空闲';
  if (job.status === 'queued') return '排队中';
  if (job.status === 'running') return '探测中';
  if (job.status === 'succeeded') return '已完成';
  return '失败';
}

function formatCatalogProbeScope(job: WebUiOpenAIModelsJob | null) {
  if (job?.accountScope) return '当前账号';
  return '后台调度';
}

function getModelRowKey(model: Pick<ManagedOpenAIModelItem, 'accountRef' | 'id'>) {
  return `${model.accountRef || 'global'}:${model.id}`;
}

function getCatalogJobScopeKey(job: Pick<WebUiOpenAIModelsJob, 'accountScope'> | null) {
  const scope = job?.accountScope;
  if (!scope) return 'global';
  return String(scope.accountRef || '').trim() || 'global';
}

function getAccountLabel(account: Pick<WebUiOpenAIModelAccount, 'displayName' | 'email' | 'accountRef' | 'provider'>) {
  if (account.displayName) return account.displayName;
  if (account.email) return account.email;
  const providerName = providerNames[account.provider];
  if (providerName && String(account.accountRef || '').startsWith('acct_')) {
    return `${providerName} 账号`;
  }
  return account.accountRef;
}

function normalizeModelAccountAuthType(value?: string) {
  const authType = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (authType === 'apikey') return 'api-key';
  if (authType === 'authtoken' || authType === 'claude-code-token') return 'auth-token';
  return authType;
}

function isApiCredentialModelAccount(account?: Pick<WebUiOpenAIModelAccount, 'apiKeyMode' | 'authType'> | null) {
  const authType = normalizeModelAccountAuthType(account?.authType);
  return Boolean(account && (
    account.apiKeyMode === true
    || authType === 'api-key'
    || authType === 'auth-token'
  ));
}

function normalizeProvider(value: string | null): ProviderFilter {
  return value && PROVIDERS.includes(value as Provider) ? value as Provider : 'all';
}

function sortProviders(providers: Provider[]) {
  const order = new Map(PROVIDERS.map((provider, index) => [provider, index]));
  return [...providers].sort((left, right) => {
    return (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right);
  });
}

// 从模型 id 抽取版本向量做"版本判断"：claude-opus-4-8 → [4,8]、gpt-5 → [5]、gemini-2.5-pro → [2,5]。
function parseModelVersion(id: string): number[] {
  const matches = String(id || '').match(/\d+/g);
  return matches ? matches.map((chunk) => Number(chunk)) : [];
}

// 版本降序：越新（版本号越大）的模型排越前；缺失位补 -1 让"无版本"沉底。
function compareModelVersionDesc(leftId: string, rightId: string) {
  const left = parseModelVersion(leftId);
  const right = parseModelVersion(rightId);
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const leftValue = left[index] ?? -1;
    const rightValue = right[index] ?? -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

// 账号模型列表排序：默认模型永远置顶 → 其次版本新→旧 → 最后 id 兜底。
function compareAccountModelRows(left: ManagedOpenAIModelItem, right: ManagedOpenAIModelItem) {
  const leftDefault = left.defaultModel === true ? 0 : 1;
  const rightDefault = right.defaultModel === true ? 0 : 1;
  if (leftDefault !== rightDefault) return leftDefault - rightDefault;
  return compareModelVersionDesc(left.id, right.id) || left.id.localeCompare(right.id);
}

function isGlobalModelVisible(row: Pick<GlobalModelRow, 'enabledCount' | 'visible'>) {
  return row.visible || row.enabledCount > 0;
}

function globalModelMatchesStatus(row: GlobalModelRow, status: ModelStatusFilter) {
  const visible = isGlobalModelVisible(row);
  if (status === 'enabled') return visible;
  if (status === 'disabled') return !visible && row.disabledCount > 0;
  if (status === 'manual') return visible && row.manualCount > 0;
  return visible;
}

function globalModelMatchesQuery(row: GlobalModelRow, query: string) {
  if (!query) return true;
  return row.id.toLowerCase().includes(query)
    || row.owned_by.toLowerCase().includes(query)
    || row.accounts.some((account) => (
      account.key.toLowerCase().includes(query)
      || account.label.toLowerCase().includes(query)
    ));
}

export default function Models() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const routeParams = useParams<{ provider?: string; accountRef?: string }>();
  const routeProvider = normalizeProvider(routeParams.provider || null);
  const routeAccountRef = String(routeParams.accountRef || '').trim();
  const scopedProvider = routeProvider === 'all' ? null : routeProvider;
  const scopedAccountRef = routeAccountRef;
  const accountScoped = Boolean(scopedProvider && scopedAccountRef);
  const pageScopeKey = accountScoped ? scopedAccountRef : 'global';
  const [catalog, setCatalog] = useState<WebUiOpenAIModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogJob, setCatalogJob] = useState<WebUiOpenAIModelsJob | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(() => scopedProvider || normalizeProvider(searchParams.get('provider')));
  const [accountFilter, setAccountFilter] = useState<AccountFilter>(() => scopedAccountRef || searchParams.get('accountRef') || 'all');
  const [statusFilter, setStatusFilter] = useState<ModelStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [updatingModelKeys, setUpdatingModelKeys] = useState<Set<string>>(() => new Set());
  const [manualForm] = Form.useForm();
  const manualProvider = Form.useWatch('provider', manualForm) as Provider | undefined;
  const [queryKeyword, setQueryKeyword] = useState('');
  const completedCatalogJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryKeyword(keyword), 220);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (accountScoped && scopedProvider) {
      setProviderFilter(scopedProvider);
      setAccountFilter(scopedAccountRef || 'all');
      return;
    }
    setProviderFilter(normalizeProvider(searchParams.get('provider')));
    setAccountFilter(searchParams.get('accountRef') || 'all');
  }, [accountScoped, scopedAccountRef, scopedProvider, searchParams]);

  const buildCatalogRequestOptions = useCallback(() => {
    if (!accountScoped || !scopedAccountRef) return {};
    return {
      accountRef: scopedAccountRef
    };
  }, [accountScoped, scopedAccountRef]);

  const loadModels = useCallback(async (options: { refresh?: boolean; quiet?: boolean } = {}) => {
    setLoading(true);
    try {
      const payload = await modelsAPI.listOpenAICompatible(buildCatalogRequestOptions());
      setCatalog(payload);
      if (!options.quiet) {
        message.success('模型缓存已重新读取');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '加载模型目录失败');
    } finally {
      setLoading(false);
    }
  }, [accountScoped, buildCatalogRequestOptions]);

  useEffect(() => {
    loadModels({ quiet: true });
  }, [loadModels]);

  const handleCatalogJobUpdate = useCallback((job: WebUiOpenAIModelsJob) => {
    if (getCatalogJobScopeKey(job) !== pageScopeKey) return;
    setCatalogJob(job);
    if (job.catalog) setCatalog(job.catalog);
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedCatalogJobIdsRef.current.has(job.id)) return;
    completedCatalogJobIdsRef.current.add(job.id);
    if (job.status === 'succeeded') {
      message.success(accountScoped ? '账号模型已刷新' : '模型目录已刷新');
      return;
    }
    message.error(job.error || '刷新模型目录失败');
  }, [accountScoped, pageScopeKey]);

  useEffect(() => {
    const watcher = modelsAPI.watchOpenAICompatibleRefresh({
      onSnapshot: (jobs) => {
        const sorted = [...jobs].sort((left, right) => {
          const leftAt = Number(left.finishedAt || left.startedAt || 0);
          const rightAt = Number(right.finishedAt || right.startedAt || 0);
          return rightAt - leftAt;
        });
        const latest = sorted
          .filter((job) => getCatalogJobScopeKey(job) === pageScopeKey)
          .find(isCatalogJobActive) || sorted.find((job) => getCatalogJobScopeKey(job) === pageScopeKey) || null;
        if (!latest) return;
        setCatalogJob(latest);
        if (latest.catalog) setCatalog(latest.catalog);
      },
      onJob: handleCatalogJobUpdate
    });
    return () => watcher.close();
  }, [handleCatalogJobUpdate, pageScopeKey]);

  const refreshModels = useCallback(async () => {
    if (!accountScoped) {
      await loadModels();
      return;
    }
    if (!scopedAccountRef) {
      message.error('当前账号缺少公开引用，请从账号列表重新进入');
      return;
    }
    setLoading(true);
    try {
      const response = await modelsAPI.refreshOpenAICompatible(buildCatalogRequestOptions());
      setCatalogJob(response.job || null);
      if (response.job?.catalog) setCatalog(response.job.catalog);
      message.info(response.alreadyRunning ? '账号模型探测已在进行' : '账号模型探测已开始');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '刷新模型目录失败');
    } finally {
      setLoading(false);
    }
  }, [accountScoped, buildCatalogRequestOptions, loadModels, scopedAccountRef]);

  const managedSource = useMemo<ManagedOpenAIModelItem[]>(() => {
    const managed = Array.isArray(catalog?.managedData) ? catalog.managedData : [];
    return managed.filter((model) => model.accountRef && model.provider);
  }, [catalog]);

  const accountOptions = useMemo<WebUiOpenAIModelAccount[]>(() => {
    const accountsByRef = new Map<string, WebUiOpenAIModelAccount>();
    (Array.isArray(catalog?.accounts) ? catalog.accounts : []).forEach((account) => {
      if (!account.accountRef) return;
      accountsByRef.set(account.accountRef, account);
    });
    managedSource.forEach((model) => {
      if (!model.accountRef || accountsByRef.has(model.accountRef)) return;
      accountsByRef.set(model.accountRef, {
        provider: model.provider,
        accountRef: model.accountRef,
        displayName: model.accountRef
      });
    });
    if (accountScoped && scopedProvider && scopedAccountRef && !accountsByRef.has(scopedAccountRef)) {
      accountsByRef.set(scopedAccountRef, {
        provider: scopedProvider,
        accountRef: scopedAccountRef,
        displayName: scopedAccountRef
      });
    }
    return Array.from(accountsByRef.values()).sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.accountRef.localeCompare(right.accountRef)
    ));
  }, [accountScoped, catalog, managedSource, scopedAccountRef, scopedProvider]);

  const accountByRef = useMemo(() => {
    return new Map(accountOptions.map((account) => [account.accountRef, account]));
  }, [accountOptions]);

  const scopedAccount = scopedAccountRef ? accountByRef.get(scopedAccountRef) : null;
  const scopedAccountLabel = scopedAccount ? getAccountLabel(scopedAccount) : scopedAccountRef;

  useEffect(() => {
    if (!manualModalOpen) return;
    const provider = manualProvider || 'codex';
    const currentAccountRef = String(manualForm.getFieldValue('accountRef') || '');
    const currentAccount = accountByRef.get(currentAccountRef);
    if (currentAccount && isApiCredentialModelAccount(currentAccount) && currentAccount.provider === provider) return;
    const source = accountScoped && scopedAccount && isApiCredentialModelAccount(scopedAccount)
      ? [scopedAccount]
      : accountOptions.filter(isApiCredentialModelAccount);
    const nextAccount = source.find((account) => account.provider === provider);
    manualForm.setFieldsValue({ accountRef: nextAccount?.accountRef });
  }, [accountByRef, accountOptions, accountScoped, manualForm, manualModalOpen, manualProvider, scopedAccount]);

  const openManualModal = useCallback(() => {
    const selectedAccount = accountScoped
      ? accountByRef.get(scopedAccountRef)
      : accountFilter !== 'all' ? accountByRef.get(accountFilter) : null;
    if (accountScoped && !isApiCredentialModelAccount(selectedAccount)) {
      message.warning('OAuth 账号不能新增自定义模型');
      return;
    }
    const eligibleAccounts = accountOptions.filter(isApiCredentialModelAccount);
    if (eligibleAccounts.length < 1) {
      message.warning('没有可新增自定义模型的密钥/令牌账号');
      return;
    }
    const preferredProvider = accountScoped && scopedProvider
      ? scopedProvider
      : selectedAccount?.provider || (providerFilter === 'all' ? 'codex' : providerFilter);
    const account = selectedAccount && isApiCredentialModelAccount(selectedAccount) && selectedAccount.provider === preferredProvider
      ? selectedAccount
      : eligibleAccounts.find((item) => item.provider === preferredProvider) || eligibleAccounts[0];
    manualForm.setFieldsValue({
      provider: account?.provider || preferredProvider,
      accountRef: account?.accountRef,
      enabled: true
    });
    setManualModalOpen(true);
  }, [accountByRef, accountFilter, accountOptions, accountScoped, manualForm, providerFilter, scopedAccountRef, scopedProvider]);

  const submitManualModel = useCallback(async (submittedValues?: Record<string, any>) => {
    const values = submittedValues && typeof submittedValues === 'object'
      ? submittedValues
      : await manualForm.validateFields();
    const account = accountByRef.get(values.accountRef);
    if (!isApiCredentialModelAccount(account)) {
      message.error('OAuth 账号不能新增自定义模型，请选择密钥/令牌账号');
      return false;
    }
    try {
      await modelsAPI.createManualModel({
        id: values.id,
        provider: account?.provider || values.provider,
        accountRef: values.accountRef,
        description: values.description,
        enabled: values.enabled !== false
      });
      message.success('模型已添加');
      setManualModalOpen(false);
      manualForm.resetFields();
      await loadModels({ quiet: true });
      return true;
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '添加模型失败');
      return false;
    }
  }, [accountByRef, loadModels, manualForm]);

  const updateModelEnabled = useCallback(async (model: ManagedOpenAIModelItem, enabled: boolean) => {
    const rowKey = getModelRowKey(model);
    setUpdatingModelKeys((current) => new Set(current).add(rowKey));
    try {
      await modelsAPI.updateModel({
        id: model.id,
        accountRef: model.accountRef,
        provider: model.provider,
        enabled
      });
      message.success(enabled ? '模型已启用' : '模型已停用');
      await loadModels({ quiet: true });
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '更新模型状态失败');
    } finally {
      setUpdatingModelKeys((current) => {
        const next = new Set(current);
        next.delete(rowKey);
        return next;
      });
    }
  }, [loadModels]);

  const updateModelDefault = useCallback(async (model: ManagedOpenAIModelItem, checked: boolean) => {
    if (!checked) {
      message.info('每个账号保留一个默认模型，请直接切换到其他模型');
      return;
    }
    if (model.enabled === false) {
      message.warning('请先启用模型');
      return;
    }
    const rowKey = getModelRowKey(model);
    setUpdatingModelKeys((current) => new Set(current).add(rowKey));
    try {
      await modelsAPI.updateModel({
        id: model.id,
        accountRef: model.accountRef,
        provider: model.provider,
        enabled: true,
        defaultModel: true
      });
      message.success('默认模型已更新');
      await loadModels({ quiet: true });
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '设置默认模型失败');
    } finally {
      setUpdatingModelKeys((current) => {
        const next = new Set(current);
        next.delete(rowKey);
        return next;
      });
    }
  }, [loadModels]);

  const deleteManualModel = useCallback((model: ManagedOpenAIModelItem) => {
    const account = accountByRef.get(model.accountRef);
    const label = account ? getAccountLabel(account) : model.accountRef;
    Modal.confirm({
      title: '删除手动模型',
      content: `${label && !label.startsWith('acct_') ? label : 'API Key'} · ${model.id}`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await modelsAPI.deleteModel({
            id: model.id,
            accountRef: model.accountRef,
            provider: model.provider
          });
          message.success('模型已删除');
          await loadModels({ quiet: true });
        } catch (error: any) {
          message.error(error?.response?.data?.message || error?.message || '删除模型失败');
        }
      }
    });
  }, [loadModels]);

  const accountModelRows = useMemo(() => {
    const query = queryKeyword.trim().toLowerCase();
    return managedSource.filter((model) => {
      if (providerFilter !== 'all' && model.provider !== providerFilter) return false;
      if (accountFilter !== 'all' && model.accountRef !== accountFilter) return false;
      if (statusFilter === 'enabled' && model.enabled === false) return false;
      if (statusFilter === 'disabled' && model.enabled !== false) return false;
      if (statusFilter === 'manual' && model.manual !== true) return false;
      if (!query) return true;
      return model.id.toLowerCase().includes(query)
        || model.accountRef.toLowerCase().includes(query)
        || getAccountLabel(accountByRef.get(model.accountRef) || { provider: model.provider, displayName: '', email: '', accountRef: model.accountRef }).toLowerCase().includes(query);
    }).sort(compareAccountModelRows);
  }, [accountByRef, accountFilter, managedSource, providerFilter, queryKeyword, statusFilter]);

  const globalModelRows = useMemo<GlobalModelRow[]>(() => {
    const rowsById = new Map<string, GlobalModelRow>();
    const ensureRow = (model: OpenAIModelItem | ManagedOpenAIModelItem) => {
      const id = String(model.id || '').trim();
      if (!id) return null;
      const existing = rowsById.get(id);
      if (existing) return existing;
      const row: GlobalModelRow = {
        id,
        object: 'model',
        created: Number(model.created || 0),
        owned_by: model.owned_by || 'aih',
        accountModels: [],
        accounts: [],
        providers: [],
        enabledCount: 0,
        disabledCount: 0,
        manualCount: 0,
        visible: false
      };
      rowsById.set(id, row);
      return row;
    };

    (Array.isArray(catalog?.data) ? catalog.data : []).forEach((model) => {
      const row = ensureRow(model);
      if (!row) return;
      row.visible = true;
      row.created = Number(model.created || row.created || 0);
      row.owned_by = model.owned_by || row.owned_by;
      PROVIDERS.forEach((provider) => {
        if ((catalog?.byProvider?.[provider] || []).includes(model.id) && !row.providers.includes(provider)) {
          row.providers.push(provider);
        }
      });
    });

    managedSource.forEach((model) => {
      const row = ensureRow(model);
      if (!row) return;
      const account = accountByRef.get(model.accountRef);
      if (!row.providers.includes(model.provider)) row.providers.push(model.provider);
      row.accountModels.push(model);
      row.accounts.push({
        key: model.accountRef,
        label: account ? getAccountLabel(account) : model.accountRef,
        model
      });
      if (model.enabled === false) {
        row.disabledCount += 1;
      } else {
        row.enabledCount += 1;
      }
      if (model.manual) row.manualCount += 1;
      if (!row.owned_by || row.owned_by === 'aih') row.owned_by = model.owned_by || row.owned_by;
    });

    return Array.from(rowsById.values())
      .map((row) => {
        const accountsByRef = new Map<string, GlobalModelAccount>();
        row.accounts.forEach((account) => {
          if (!accountsByRef.has(account.key)) accountsByRef.set(account.key, account);
        });
        return {
          ...row,
          providers: sortProviders(row.providers),
          accountModels: [...row.accountModels].sort((left, right) => (
            left.provider.localeCompare(right.provider)
            || left.accountRef.localeCompare(right.accountRef)
          )),
          accounts: Array.from(accountsByRef.values()).sort((left, right) => {
            const leftDisabled = left.model.enabled === false ? 1 : 0;
            const rightDisabled = right.model.enabled === false ? 1 : 0;
            return leftDisabled - rightDisabled
              || left.model.provider.localeCompare(right.model.provider)
              || left.label.localeCompare(right.label);
          })
        };
      })
      .sort((left, right) => {
        const leftVisible = isGlobalModelVisible(left) ? 0 : 1;
        const rightVisible = isGlobalModelVisible(right) ? 0 : 1;
        return leftVisible - rightVisible || left.id.localeCompare(right.id);
      });
  }, [accountByRef, catalog, managedSource]);

  const globalRows = useMemo(() => {
    const query = queryKeyword.trim().toLowerCase();
    return globalModelRows.filter((row) => {
      if (providerFilter !== 'all' && !row.providers.includes(providerFilter)) return false;
      if (accountFilter !== 'all' && !row.accountModels.some((model) => model.accountRef === accountFilter)) return false;
      if (!globalModelMatchesStatus(row, statusFilter)) return false;
      return globalModelMatchesQuery(row, query);
    });
  }, [accountFilter, globalModelRows, providerFilter, queryKeyword, statusFilter]);

  const providerCountRows = useMemo(() => {
    const query = queryKeyword.trim().toLowerCase();
    return globalModelRows.filter((row) => {
      if (accountFilter !== 'all' && !row.accountModels.some((model) => model.accountRef === accountFilter)) return false;
      if (!globalModelMatchesStatus(row, statusFilter)) return false;
      return globalModelMatchesQuery(row, query);
    });
  }, [accountFilter, globalModelRows, queryKeyword, statusFilter]);

  const providerCounts = useMemo(() => {
    return PROVIDERS.reduce<Record<string, number>>((acc, provider) => {
      acc[provider] = providerCountRows.filter((model) => model.providers.includes(provider)).length;
      return acc;
    }, { all: providerCountRows.length });
  }, [providerCountRows]);

  const metricSource = accountScoped
    ? managedSource.filter((model) => model.accountRef === scopedAccountRef)
    : managedSource;
  const visibleUnionCount = accountScoped
    ? metricSource.filter((model) => model.enabled !== false).length
    : globalModelRows.filter(isGlobalModelVisible).length;
  const manualCount = metricSource.filter((model) => model.manual).length;
  const globalProbeError = getVisibleModelProbeError(catalog);
  const credentialAccountOptions = accountOptions.filter(isApiCredentialModelAccount);
  const manualAccountOptionSource = accountScoped && scopedAccount && isApiCredentialModelAccount(scopedAccount)
    ? [scopedAccount]
    : credentialAccountOptions.filter((account) => account.provider === (manualProvider || 'codex'));
  const manualAccountOptions = manualAccountOptionSource
    .map((account) => ({
      label: `${getAccountLabel(account)} · 密钥/令牌账号`,
      value: account.accountRef
    }));
  const canCreateManualModel = accountScoped
    ? isApiCredentialModelAccount(scopedAccount)
    : credentialAccountOptions.length > 0;
  const manualModelUnavailableReason = accountScoped
    ? 'OAuth 账号不能新增自定义模型'
    : '没有可新增自定义模型的密钥/令牌账号';

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      message.success('模型 ID 已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  };

  const renderManualModelButton = () => (
    <Tooltip title={canCreateManualModel ? '' : manualModelUnavailableReason}>
      <span>
        <Button
          disabled={!canCreateManualModel}
          icon={<PlusOutlined />}
          onClick={openManualModal}
        >
          添加模型
        </Button>
      </span>
    </Tooltip>
  );

  const renderModelRow = (model: ManagedOpenAIModelItem) => {
    const enabled = model.enabled !== false;
    const rowKey = getModelRowKey(model);
    const defaultControlTip = model.defaultModel
      ? '当前账号默认模型；切换其他模型即可替换'
      : (enabled ? '设为此账号默认模型' : '启用模型后可设为默认');
    return (
      <div className={`models-model-row ${enabled ? '' : 'models-model-row--disabled'}`.trim()} key={rowKey}>
        <div className="models-model-row-main">
          <div className="models-model-title-line">
            <h3 title={model.id}>{model.id}</h3>
            <Tooltip title="复制模型 ID">
              <Button
                className="copy-icon-btn"
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyModelId(model.id)}
              />
            </Tooltip>
          </div>
          <div className="models-model-row-tags">
            {model.manual ? <Tag color="processing">手动</Tag> : <Tag>探测</Tag>}
            {model.defaultModel ? <Tag color="success">默认</Tag> : null}
            {!enabled ? <Tag>停用</Tag> : null}
          </div>
          <p>{model.object} · {model.owned_by || 'aih'}{model.description ? ` · ${model.description}` : ''}</p>
        </div>
        {isMobile ? (
          /* 移动端:iOS 式带标签整行开关(标签在左、开关在右),不再把文字塞进胶囊、
             也不再让两个开关一左一右飘着。 */
          <div className="models-model-row-controls">
            <div className="models-toggle-row">
              <span className="models-toggle-label">启用此模型</span>
              <Switch
                checked={enabled}
                loading={updatingModelKeys.has(rowKey)}
                aria-label={`${enabled ? '停用' : '启用'} ${model.accountRef} ${model.id}`}
                onChange={(checked) => updateModelEnabled(model, checked)}
              />
            </div>
            <div className="models-toggle-row">
              <span className={`models-toggle-label ${model.defaultModel ? 'models-toggle-label--active' : ''}`.trim()}>
                设为账号默认
              </span>
              <Switch
                checked={model.defaultModel === true}
                disabled={!enabled || updatingModelKeys.has(rowKey)}
                loading={updatingModelKeys.has(rowKey)}
                aria-label={`默认模型 ${model.accountRef} ${model.id}`}
                onChange={(checked) => updateModelDefault(model, checked)}
              />
            </div>
            {model.manual ? (
              <div className="models-toggle-row">
                <span className="models-toggle-label">手动补充模型</span>
                <Button
                  danger
                  appVariant="icon"
                  icon={<DeleteOutlined />}
                  aria-label="删除手动模型"
                  onClick={() => deleteManualModel(model)}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="models-model-row-state">
              <Switch
                className="models-model-switch"
                checked={enabled}
                loading={updatingModelKeys.has(rowKey)}
                checkedChildren="启用"
                unCheckedChildren="停用"
                aria-label={`${enabled ? '停用' : '启用'} ${model.accountRef} ${model.id}`}
                onChange={(checked) => updateModelEnabled(model, checked)}
              />
            </div>
            <div className="models-model-row-actions">
              <Tooltip title={defaultControlTip}>
                <div className={`models-model-default-control ${model.defaultModel ? 'models-model-default-control--active' : ''}`.trim()}>
                  <Switch
                    className="models-model-switch models-model-default-switch"
                    checked={model.defaultModel === true}
                    disabled={!enabled || updatingModelKeys.has(rowKey)}
                    loading={updatingModelKeys.has(rowKey)}
                    checkedChildren="默认"
                    unCheckedChildren="默认"
                    aria-label={`默认模型 ${model.accountRef} ${model.id}`}
                    onChange={(checked) => updateModelDefault(model, checked)}
                  />
                </div>
              </Tooltip>
              {model.manual ? (
                <Tooltip title="删除手动模型">
                  <Button
                    danger
                    appVariant="icon"
                    icon={<DeleteOutlined />}
                    onClick={() => deleteManualModel(model)}
                  />
                </Tooltip>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderGlobalModelRow = (model: GlobalModelRow) => {
    const visible = isGlobalModelVisible(model);
    return (
      <article className={`models-global-row ${visible ? '' : 'models-global-row--disabled'}`.trim()} key={model.id}>
        <div className="models-global-main">
          <div className="models-global-title-line">
            <h3 title={model.id}>{model.id}</h3>
            <Tooltip title="复制模型 ID">
              <Button
                className="copy-icon-btn"
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyModelId(model.id)}
              />
            </Tooltip>
            <div className="models-global-providers">
              {model.providers.length > 0 ? model.providers.map((provider) => (
                <Tag className="models-provider-tag" key={provider}>
                  <ProviderIcon provider={provider} size={12} />
                  <span>{providerNames[provider]}</span>
                </Tag>
              )) : <Tag>未知来源</Tag>}
              {!visible ? <Tag>不可见</Tag> : null}
              {model.manualCount > 0 ? <Tag color="processing">手动 {model.manualCount}</Tag> : null}
            </div>
          </div>
          <p>
            {model.object} · {model.owned_by || 'aih'} · 启用账号 {model.enabledCount}
            {model.disabledCount > 0 ? ` · 停用账号 ${model.disabledCount}` : ''}
          </p>
        </div>
      </article>
    );
  };

  return (
    <PageScaffold ghost
      title={accountScoped ? '账号模型管理' : '全局模型目录'}
      subTitle={accountScoped
        ? `${scopedAccountLabel && !scopedAccountLabel.startsWith('acct_') ? scopedAccountLabel : (scopedProvider ? `${providerNames[scopedProvider]} 账号` : '当前账号')} 的独立模型开关和手动补充。`
        : '按模型聚合展示可见状态；客户端看到的是所有启用账号模型的去重合集。'}
      extra={isMobile ? (
        <div className="m-header-actions">
          {accountScoped ? (
            <MobileBackButton className="m-icon-btn" title="返回账号" onClick={() => navigate('/accounts')} />
          ) : null}
          {renderManualModelButton()}
          <button
            className="m-icon-btn primary"
            aria-label="刷新模型"
            disabled={loading || isCatalogJobActive(catalogJob)}
            onClick={refreshModels}
          >
            <ReloadOutlined spin={loading || isCatalogJobActive(catalogJob)} />
          </button>
        </div>
      ) : [
        accountScoped && (
          <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
            返回账号
          </Button>
        ),
        renderManualModelButton(),
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          loading={loading || isCatalogJobActive(catalogJob)}
          onClick={refreshModels}
        >
          刷新模型
        </Button>
      ].filter(Boolean)}
    >
      {/* 顶部统计 —— 框架 StatisticCard.Group */}
      <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard statistic={{ title: '账号模型', value: metricSource.length }} />
        <StatisticCard statistic={{ title: accountScoped ? '启用模型' : '可见模型', value: visibleUnionCount }} />
        <StatisticCard statistic={{ title: '手动补充', value: manualCount }} />
      </StatisticCard.Group>

      {globalProbeError ? (() => {
        const probeError = parseUpstreamError(globalProbeError);
        return (
          <Alert
            type={catalog?.source === 'remote' ? 'warning' : 'error'}
            showIcon
            style={{ marginBottom: 16 }}
            message={(
              <Space size={8} wrap>
                <span>部分账号模型探测失败</span>
                {probeError.statusCode ? <Tag color="error" style={{ marginInlineEnd: 0 }}>HTTP {probeError.statusCode}</Tag> : null}
              </Space>
            )}
            description={(
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Paragraph
                  type="secondary"
                  style={{ margin: 0, fontSize: 13 }}
                  ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
                >
                  {probeError.message}
                </Typography.Paragraph>
                <Space size={12} wrap>
                  {probeError.url ? (
                    <Typography.Link
                      href={probeError.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12 }}
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalUrl(probeError.url).catch(() => message.error('无法打开外部链接'));
                      }}
                    >
                      提交上游 issue ›
                    </Typography.Link>
                  ) : null}
                  <Typography.Text
                    type="secondary"
                    copyable={{ text: probeError.raw, tooltips: ['复制原始错误', '已复制'] }}
                    style={{ fontSize: 12 }}
                  >
                    原始错误
                  </Typography.Text>
                </Space>
              </Space>
            )}
          />
        );
      })() : null}

      {catalogJob ? (
        <SectionCard
          className={`models-live-refresh models-live-refresh--${catalogJob.status} animate__animated animate__fadeIn animate__faster`}
        >
          <div className="models-live-refresh-grid">
            <div>
              <span>刷新状态</span>
              <strong>{formatCatalogJobStatus(catalogJob)}</strong>
            </div>
            <div>
              <span>探测范围</span>
              <strong>{formatCatalogProbeScope(catalogJob)}</strong>
            </div>
            <div>
              <span>可见模型</span>
              <strong>{catalogJob.catalog?.data.length ?? '-'}</strong>
            </div>
            <div>
              <span>探测账号</span>
              <strong>{catalogJob.catalog?.scannedAccounts ?? '-'}</strong>
            </div>
          </div>
          {catalogJob.error ? <p>{catalogJob.error}</p> : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title={accountScoped ? '当前账号模型' : '模型目录'}
        extra={(
          <Tag color={catalog?.cached ? 'default' : 'processing'}>
            {catalog?.cached ? '缓存' : '实时'}
          </Tag>
        )}
      >
        <p className="models-catalog-desc">
          {accountScoped
            ? `${scopedAccountLabel && !scopedAccountLabel.startsWith('acct_') ? scopedAccountLabel : (scopedProvider ? `${providerNames[scopedProvider]} 账号` : '当前账号')}，更新时间 ${formatUpdatedAt(catalog?.updatedAt)}。`
            : `端点 ${catalog?.endpoint || '/v1/models'}，当前可见模型 ${visibleUnionCount} 个。更新时间 ${formatUpdatedAt(catalog?.updatedAt)}。`}
        </p>

        {accountScoped ? (
          <div className="models-account-context">
            <div className="models-account-context-main">
              {scopedProvider ? <ProviderIcon provider={scopedProvider} size={20} /> : <ApiOutlined />}
              <div>
                <strong>{scopedAccountLabel && !scopedAccountLabel.startsWith('acct_') ? scopedAccountLabel : (scopedProvider ? `${providerNames[scopedProvider]} 账号` : '当前账号')}</strong>
              </div>
            </div>
            <div className="models-account-context-stats">
              <span>{metricSource.length} 个账号模型</span>
              <span>{visibleUnionCount} 个启用</span>
              <span>{manualCount} 个手动</span>
            </div>
          </div>
        ) : null}

        <DataToolbar
          filters={(
            <>
              {!accountScoped ? (
                <>
                  <Segmented
                    value={providerFilter}
                    onChange={(value) => {
                      setProviderFilter(value as ProviderFilter);
                      setAccountFilter('all');
                    }}
                    options={[
                      { label: `全部 ${providerCounts.all || 0}`, value: 'all' },
                      ...PROVIDERS.map((provider) => ({
                        label: `${providerNames[provider]} ${providerCounts[provider] || 0}`,
                        value: provider
                      }))
                    ]}
                  />
                  <Select
                    className="models-account-filter"
                    value={accountFilter}
                    onChange={(value) => setAccountFilter(value)}
                    options={[
                      { label: '全部账号', value: 'all' },
                      ...accountOptions
                        .filter((account) => providerFilter === 'all' || account.provider === providerFilter)
                        .map((account) => ({
                          label: (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <ProviderIcon provider={account.provider} size={14} />
                              <span>{getAccountLabel(account)}</span>
                            </span>
                          ),
                          value: account.accountRef
                        }))
                    ]}
                  />
                </>
              ) : null}
              <Input.Search
                allowClear
                className="models-search"
                placeholder={accountScoped ? '搜索模型' : '搜索模型 ID'}
                value={keyword}
                onChange={(event) => {
                  const value = event.target.value;
                  setKeyword(value);
                }}
              />
              <Segmented
                value={statusFilter}
                onChange={(value) => setStatusFilter(value as ModelStatusFilter)}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '启用', value: 'enabled' },
                  { label: '停用', value: 'disabled' },
                  { label: '手动', value: 'manual' }
                ]}
              />
            </>
          )}
        />

        {accountScoped ? (
          <PaginatedList<ManagedOpenAIModelItem>
            className="models-list models-list--account"
            items={accountModelRows}
            pageSize={16}
            emptyText="暂无数据"
            renderItem={(model) => renderModelRow(model)}
          />
        ) : (
          <PaginatedList<GlobalModelRow>
            className="models-list"
            items={globalRows}
            pageSize={14}
            emptyText="暂无数据"
            renderItem={(model) => renderGlobalModelRow(model)}
          />
        )}
      </SectionCard>

      <ModalForm
        title="手动添加模型"
        open={manualModalOpen}
        onOpenChange={setManualModalOpen}
        form={manualForm}
        layout="vertical"
        initialValues={{ provider: 'codex', enabled: true }}
        onFinish={submitManualModel}
        submitter={{
          searchConfig: {
            submitText: '添加',
            resetText: '取消',
          },
        }}
        modalProps={{
          destroyOnClose: true,
        }}
      >
        <div style={{ marginTop: '12px' }}>
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select
              disabled={accountScoped}
              options={PROVIDERS.map((provider) => ({
                label: providerNames[provider],
                value: provider,
                disabled: !credentialAccountOptions.some((account) => account.provider === provider)
              }))}
            />
          </Form.Item>
          <Form.Item
            name="accountRef"
            label="账号"
            rules={[{ required: true, message: '请选择账号' }]}
          >
            <Select disabled={accountScoped} options={manualAccountOptions} placeholder="选择密钥/令牌账号" />
          </Form.Item>
          <Form.Item
            name="id"
            label="模型 ID"
            rules={[{ required: true, message: '请输入模型 ID' }]}
          >
            <Input placeholder="例如 gpt-5.4 或 provider-custom-model" autoFocus />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <Input placeholder="可选，用于区分手动补充来源" />
          </Form.Item>
          <Form.Item name="enabled" label="默认启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
      </ModalForm>
    </PageScaffold>
  );
}
