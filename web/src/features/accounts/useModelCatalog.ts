import React from 'react';
import { message } from 'antd';
import { modelsAPI } from '@/services/api';
import type { Account, WebUiModelsResponse, WebUiOpenAIModelsJob } from '@/types';
import {
  buildAccountModelCatalogFromOpenAI,
  getAccountRef,
  getModelCatalogAccountScope,
  getModelCatalogJobAccountRef,
  isModelCatalogJobActive
} from '@/features/accounts/account-model-catalog';

export interface UseModelCatalogResult {
  modelCatalog: WebUiModelsResponse | null;
  refreshingModelAccountRefs: Record<string, boolean>;
  refreshAccountModelCatalog: (record: Account, options?: { quiet?: boolean }) => Promise<void>;
  clearModelAccountRefreshing: (accountRef: string) => void;
  loadModelCatalog: (options?: { quiet?: boolean }) => Promise<void>;
}

export function useModelCatalog(accounts: Account[]): UseModelCatalogResult {
  const [modelCatalog, setModelCatalog] = React.useState<WebUiModelsResponse | null>(null);
  const [refreshingModelAccountRefs, setRefreshingModelAccountRefs] = React.useState<Record<string, boolean>>({});
  const requestedModelCatalogJobIdsRef = React.useRef<Set<string>>(new Set());

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

  const modelCatalogAccountRefsSignature = React.useMemo(() => {
    return accounts
      .map((account) => getAccountRef(account))
      .filter(Boolean)
      .sort()
      .join('|');
  }, [accounts]);

  React.useEffect(() => {
    loadModelCatalog({ quiet: true });
  }, [loadModelCatalog, modelCatalogAccountRefsSignature]);

  React.useEffect(() => {
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

  return {
    modelCatalog,
    refreshingModelAccountRefs,
    refreshAccountModelCatalog,
    clearModelAccountRefreshing,
    loadModelCatalog
  };
}
