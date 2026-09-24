import { message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modelsAPI } from '@/services/api';
import type {
  ManagedOpenAIModelItem,
  Provider,
  WebUiOpenAIModelAccount,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse
} from '@/types';
import {
  DEFAULT_MANUAL_MODEL_PROVIDER,
  buildGlobalModelRows,
  buildManualProviderOptions,
  buildModelAccountOptions,
  countGlobalModelRowsByProvider,
  filterGlobalModelRows,
  getCatalogJobScopeKey,
  getManagedModelSource,
  getVisibleModelProbeError,
  isCatalogJobActive,
  isGlobalModelVisible,
  pickLatestCatalogJob,
  resolveManualModelDefaults,
  type AccountFilter,
  type GlobalModelRow,
  type ModelStatusFilter,
  type ProviderFilter
} from './model-catalog';

const GLOBAL_SCOPE_KEY = 'global';

export interface ManualModelValues {
  provider?: Provider;
  accountRef?: string;
  id?: string;
  description?: string;
  enabled?: boolean;
}

const errorText = (error: unknown, fallback: string) => {
  const source = error as { response?: { data?: { message?: string } }; message?: string } | null;
  return source?.response?.data?.message || source?.message || fallback;
};

/**
 * 全局模型目录（/models，非账号作用域）的数据与动作：
 * 与桌面 Models.tsx 全局分支同一套 API（modelsAPI.listOpenAICompatible / watchOpenAICompatibleRefresh /
 * createManualModel）、同一套提示文案与筛选口径（features/models/model-catalog）。
 */
export function useModelCatalogPage(queryFilters: { provider: ProviderFilter; account: AccountFilter } = { provider: 'all', account: 'all' }) {
  const [catalog, setCatalog] = useState<WebUiOpenAIModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [catalogJob, setCatalogJob] = useState<WebUiOpenAIModelsJob | null>(null);
  const [providerFilter, setProviderFilterState] = useState<ProviderFilter>(queryFilters.provider);
  const [accountFilter, setAccountFilter] = useState<AccountFilter>(queryFilters.account);
  const [statusFilter, setStatusFilter] = useState<ModelStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [queryKeyword, setQueryKeyword] = useState('');
  const completedCatalogJobIdsRef = useRef<Set<string>>(new Set());

  // URL ?provider= / ?accountRef= 变化时同步筛选（与桌面一致）
  useEffect(() => {
    setProviderFilterState(queryFilters.provider);
    setAccountFilter(queryFilters.account);
  }, [queryFilters.account, queryFilters.provider]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryKeyword(keyword), 220);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const loadModels = useCallback(async (options: { quiet?: boolean } = {}) => {
    setLoading(true);
    try {
      const payload = await modelsAPI.listOpenAICompatible({});
      setCatalog(payload);
      setLoadError('');
      if (!options.quiet) {
        message.success('模型缓存已重新读取');
      }
    } catch (error: unknown) {
      const text = errorText(error, '加载模型目录失败');
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadModels({ quiet: true });
  }, [loadModels]);

  const handleCatalogJobUpdate = useCallback((job: WebUiOpenAIModelsJob) => {
    if (getCatalogJobScopeKey(job) !== GLOBAL_SCOPE_KEY) return;
    setCatalogJob(job);
    if (job.catalog) setCatalog(job.catalog);
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedCatalogJobIdsRef.current.has(job.id)) return;
    completedCatalogJobIdsRef.current.add(job.id);
    if (job.status === 'succeeded') {
      message.success('模型目录已刷新');
      return;
    }
    message.error(job.error || '刷新模型目录失败');
  }, []);

  useEffect(() => {
    const watcher = modelsAPI.watchOpenAICompatibleRefresh({
      onSnapshot: (jobs) => {
        const latest = pickLatestCatalogJob(jobs, GLOBAL_SCOPE_KEY);
        if (!latest) return;
        setCatalogJob(latest);
        if (latest.catalog) setCatalog(latest.catalog);
      },
      onJob: handleCatalogJobUpdate
    });
    return () => watcher.close();
  }, [handleCatalogJobUpdate]);

  // 全局目录的「刷新模型」= 重新读取缓存（与桌面一致；后台探测由调度任务推送）。
  const refreshModels = useCallback(() => loadModels(), [loadModels]);

  const managedSource = useMemo<ManagedOpenAIModelItem[]>(() => getManagedModelSource(catalog), [catalog]);
  const accountOptions = useMemo<WebUiOpenAIModelAccount[]>(
    () => buildModelAccountOptions(catalog, managedSource),
    [catalog, managedSource]
  );
  const accountByRef = useMemo(
    () => new Map(accountOptions.map((account) => [account.accountRef, account])),
    [accountOptions]
  );
  const globalModelRows = useMemo<GlobalModelRow[]>(
    () => buildGlobalModelRows(catalog, managedSource, accountByRef),
    [accountByRef, catalog, managedSource]
  );
  const query = queryKeyword.trim().toLowerCase();
  const rows = useMemo(() => filterGlobalModelRows(globalModelRows, {
    provider: providerFilter,
    account: accountFilter,
    status: statusFilter,
    query
  }), [accountFilter, globalModelRows, providerFilter, query, statusFilter]);
  const providerCounts = useMemo(() => countGlobalModelRowsByProvider(globalModelRows, {
    account: accountFilter,
    status: statusFilter,
    query
  }), [accountFilter, globalModelRows, query, statusFilter]);

  // 切换 Provider 时重置账号筛选（与桌面 Segmented onChange 一致）
  const setProviderFilter = useCallback((value: ProviderFilter) => {
    setProviderFilterState(value);
    setAccountFilter('all');
  }, []);

  const filteredAccountOptions = useMemo(
    () => accountOptions.filter((account) => providerFilter === 'all' || account.provider === providerFilter),
    [accountOptions, providerFilter]
  );

  const canCreateManualModel = accountOptions.length > 0;
  const manualProviderOptions = useMemo(() => buildManualProviderOptions(accountOptions), [accountOptions]);

  /** 打开「添加模型」前的守卫与默认值；返回 null 表示不可添加（已提示）。 */
  const getManualModelDefaults = useCallback(() => {
    const selectedAccount = accountFilter !== 'all' ? accountByRef.get(accountFilter) : null;
    if (accountOptions.length < 1) {
      message.warning('没有可添加模型的账号');
      return null;
    }
    const preferredProvider = selectedAccount?.provider
      || (providerFilter === 'all' ? DEFAULT_MANUAL_MODEL_PROVIDER : providerFilter);
    return resolveManualModelDefaults(accountOptions, selectedAccount, preferredProvider);
  }, [accountByRef, accountFilter, accountOptions, providerFilter]);

  const submitManualModel = useCallback(async (values: ManualModelValues) => {
    const account = accountByRef.get(String(values.accountRef || ''));
    if (!account) {
      message.error('请选择有效账号');
      return false;
    }
    try {
      await modelsAPI.createManualModel({
        id: String(values.id || ''),
        provider: account.provider || String(values.provider || ''),
        accountRef: String(values.accountRef || ''),
        description: values.description,
        enabled: values.enabled !== false
      });
      message.success('模型已添加');
      await loadModels({ quiet: true });
      return true;
    } catch (error: unknown) {
      message.error(errorText(error, '添加模型失败'));
      return false;
    }
  }, [accountByRef, loadModels]);

  const copyModelId = useCallback(async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      message.success('模型 ID 已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  }, []);

  return {
    catalog,
    loading,
    loaded,
    loadError,
    catalogJob,
    catalogJobActive: isCatalogJobActive(catalogJob),
    probeError: getVisibleModelProbeError(catalog),
    loadModels,
    refreshModels,
    // 统计（与桌面 KPI 条同口径）
    accountModelCount: managedSource.length,
    visibleModelCount: globalModelRows.filter(isGlobalModelVisible).length,
    manualModelCount: managedSource.filter((model) => model.manual).length,
    // 列表与筛选
    rows,
    providerCounts,
    providerFilter,
    setProviderFilter,
    accountFilter,
    setAccountFilter,
    statusFilter,
    setStatusFilter,
    keyword,
    setKeyword,
    accountOptions,
    filteredAccountOptions,
    accountByRef,
    // 手动添加
    canCreateManualModel,
    manualProviderOptions,
    getManualModelDefaults,
    submitManualModel,
    copyModelId
  };
}

export type ModelCatalogPageState = ReturnType<typeof useModelCatalogPage>;
