import { message } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modelsAPI } from '@/services/api';
import type {
  ManagedOpenAIModelItem,
  WebUiOpenAIModelAccount,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse
} from '@/types';
import {
  buildModelAccountOptions,
  getAccountLabel,
  getManagedModelSource,
  getModelDisplayLabel,
  getVisibleModelProbeError,
  isCatalogJobActive,
  normalizeProvider,
  pickLatestCatalogJob,
  getCatalogJobScopeKey,
  type ModelStatusFilter
} from './model-catalog';
import {
  countOpenCodeGroups,
  filterAccountModelRows,
  formatScopedAccountTitle,
  type ModelGroupFilter
} from './account-models';

export interface AccountManualModelValues {
  id?: string;
  description?: string;
  enabled?: boolean;
}

const errorText = (error: unknown, fallback: string) => {
  const source = error as { response?: { data?: { message?: string } }; message?: string } | null;
  return source?.response?.data?.message || source?.message || fallback;
};

/**
 * 单账号模型管理（/accounts/:provider/:accountRef/models）的数据与动作，从 Models.tsx 账号分支抽取：
 * - 读取：modelsAPI.listOpenAICompatible({ accountRef })
 * - 实时：modelsAPI.watchOpenAICompatibleRefresh（只接收本账号作用域的探测任务）
 * - 探测：modelsAPI.refreshOpenAICompatible({ accountRef })
 * - 开关 / 默认模型：modelsAPI.updateModel；手动补充：modelsAPI.createManualModel
 * 提示文案、守卫与桌面完全一致。
 */
export function useAccountModels(params: { provider?: string; accountRef?: string }) {
  const routeProvider = normalizeProvider(params.provider || null);
  const scopedProvider = routeProvider === 'all' ? null : routeProvider;
  const scopedAccountRef = String(params.accountRef || '').trim();
  const accountScoped = Boolean(scopedProvider && scopedAccountRef);
  const scopeKey = accountScoped ? scopedAccountRef : 'global';

  const [catalog, setCatalog] = useState<WebUiOpenAIModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [catalogJob, setCatalogJob] = useState<WebUiOpenAIModelsJob | null>(null);
  const [statusFilter, setStatusFilter] = useState<ModelStatusFilter>('all');
  const [groupFilter, setGroupFilter] = useState<ModelGroupFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [queryKeyword, setQueryKeyword] = useState('');
  const completedCatalogJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryKeyword(keyword), 220);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const loadModels = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!accountScoped) return;
    setLoading(true);
    try {
      const payload = await modelsAPI.listOpenAICompatible({ accountRef: scopedAccountRef });
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
  }, [accountScoped, scopedAccountRef]);

  useEffect(() => {
    loadModels({ quiet: true });
  }, [loadModels]);

  const handleCatalogJobUpdate = useCallback((job: WebUiOpenAIModelsJob) => {
    if (getCatalogJobScopeKey(job) !== scopeKey) return;
    setCatalogJob(job);
    if (job.catalog) setCatalog(job.catalog);
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedCatalogJobIdsRef.current.has(job.id)) return;
    completedCatalogJobIdsRef.current.add(job.id);
    if (job.status === 'succeeded') {
      message.success('账号模型已刷新');
      return;
    }
    message.error(job.error || '刷新模型目录失败');
  }, [scopeKey]);

  useEffect(() => {
    if (!accountScoped) return undefined;
    const watcher = modelsAPI.watchOpenAICompatibleRefresh({
      onSnapshot: (jobs) => {
        const latest = pickLatestCatalogJob(jobs, scopeKey);
        if (!latest) return;
        setCatalogJob(latest);
        if (latest.catalog) setCatalog(latest.catalog);
      },
      onJob: handleCatalogJobUpdate
    });
    return () => watcher.close();
  }, [accountScoped, handleCatalogJobUpdate, scopeKey]);

  /** 账号模型探测（刷新模型）：后台任务，进度经 watch 推送。 */
  const refreshModels = useCallback(async () => {
    if (!accountScoped || !scopedAccountRef) {
      message.error('当前账号缺少公开引用，请从账号列表重新进入');
      return;
    }
    setLoading(true);
    try {
      const response = await modelsAPI.refreshOpenAICompatible({ accountRef: scopedAccountRef });
      setCatalogJob(response.job || null);
      if (response.job?.catalog) setCatalog(response.job.catalog);
      message.info(response.alreadyRunning ? '账号模型探测已在进行' : '账号模型探测已开始');
    } catch (error: unknown) {
      message.error(errorText(error, '刷新模型目录失败'));
    } finally {
      setLoading(false);
    }
  }, [accountScoped, scopedAccountRef]);

  const managedSource = useMemo<ManagedOpenAIModelItem[]>(() => getManagedModelSource(catalog), [catalog]);
  const accountOptions = useMemo<WebUiOpenAIModelAccount[]>(() => buildModelAccountOptions(
    catalog,
    managedSource,
    accountScoped && scopedProvider ? { provider: scopedProvider, accountRef: scopedAccountRef } : null
  ), [accountScoped, catalog, managedSource, scopedAccountRef, scopedProvider]);
  const accountByRef = useMemo(
    () => new Map(accountOptions.map((account) => [account.accountRef, account])),
    [accountOptions]
  );
  const scopedAccount = scopedAccountRef ? accountByRef.get(scopedAccountRef) || null : null;
  const scopedAccountLabel = scopedAccount ? getAccountLabel(scopedAccount) : scopedAccountRef;
  const accountTitle = formatScopedAccountTitle(scopedAccountLabel, scopedProvider);

  const metricSource = useMemo(
    () => managedSource.filter((model) => model.accountRef === scopedAccountRef),
    [managedSource, scopedAccountRef]
  );
  const openCodeGroupCounts = useMemo(() => countOpenCodeGroups(metricSource), [metricSource]);
  const isOpenCode = scopedProvider === 'opencode';

  const rows = useMemo(() => filterAccountModelRows(managedSource, {
    provider: scopedProvider || 'all',
    accountRef: scopedAccountRef || 'all',
    status: statusFilter,
    group: groupFilter,
    query: queryKeyword.trim().toLowerCase()
  }, (model) => getAccountLabel(accountByRef.get(model.accountRef) || {
    provider: model.provider,
    displayName: '',
    email: '',
    accountRef: model.accountRef
  })), [accountByRef, groupFilter, managedSource, queryKeyword, scopedAccountRef, scopedProvider, statusFilter]);

  const updateModelEnabled = useCallback(async (model: ManagedOpenAIModelItem, enabled: boolean) => {
    try {
      await modelsAPI.updateModel({
        id: model.id,
        accountRef: model.accountRef,
        provider: model.provider,
        enabled
      });
      message.success(enabled ? '模型已启用' : '模型已停用');
      await loadModels({ quiet: true });
    } catch (error: unknown) {
      message.error(errorText(error, '更新模型状态失败'));
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
    } catch (error: unknown) {
      message.error(errorText(error, '设置默认模型失败'));
    }
  }, [loadModels]);

  /** 手动补充模型：Provider / 账号固定为当前账号（与桌面账号作用域下禁用两项下拉一致）。 */
  const createManualModel = useCallback(async (values: AccountManualModelValues) => {
    if (!scopedAccount) {
      message.error('请选择有效账号');
      return false;
    }
    try {
      await modelsAPI.createManualModel({
        id: String(values.id || ''),
        provider: scopedAccount.provider,
        accountRef: scopedAccount.accountRef,
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
  }, [loadModels, scopedAccount]);

  const copyModelId = useCallback(async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      message.success('模型 ID 已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  }, []);

  const getLabel = useCallback(
    (model: Pick<ManagedOpenAIModelItem, 'provider' | 'id'>) => getModelDisplayLabel(catalog, model.provider, model.id),
    [catalog]
  );

  return {
    accountScoped,
    scopedProvider,
    scopedAccountRef,
    scopedAccount,
    accountTitle,
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
    accountModelCount: metricSource.length,
    enabledModelCount: metricSource.filter((model) => model.enabled !== false).length,
    manualModelCount: metricSource.filter((model) => model.manual).length,
    isOpenCode,
    openCodeGroupCounts,
    // 列表与筛选
    rows,
    statusFilter,
    setStatusFilter,
    groupFilter,
    setGroupFilter,
    keyword,
    setKeyword,
    // 动作
    canCreateManualModel: Boolean(scopedAccount),
    updateModelEnabled,
    updateModelDefault,
    createManualModel,
    copyModelId,
    getModelDisplayLabel: getLabel
  };
}

export type AccountModelsState = ReturnType<typeof useAccountModels>;
