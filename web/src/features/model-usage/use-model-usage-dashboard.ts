import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import type { Dayjs } from 'dayjs';
import { providerNames } from '@/components/chat/provider-registry';
import { accountsAPI, modelUsageAPI } from '@/services/api';
import type {
  Account,
  ModelUsageBreakdownResponse,
  ModelUsageDashboardQueryJob,
  ModelUsageModelRow,
  ModelUsageQuery,
  ModelUsageRequestRow,
  ModelUsageScanJob,
  ModelUsageSessionRow,
  ModelUsageStats,
  ModelUsageTrend,
  Provider
} from '@/types';
import type { UsageBreakdownTarget } from './UsageBreakdownDrawer';
import { calculateCacheHitRate, getCacheTokens } from './model-usage-presentation';
import {
  EMPTY_USAGE_STATS,
  EMPTY_USAGE_TREND,
  USAGE_REQUEST_DETAIL_LIMIT,
  buildUsageQuery,
  buildUsageRangeByMode,
  isUsageDashboardQueryActive,
  isUsageScanJobActive,
  type UsageProviderFilter,
  type UsageRangeMode
} from './model-usage-query';

function getErrorMessage(error: unknown, fallback: string) {
  const requestError = error as { message?: string; response?: { data?: { message?: string } } };
  return requestError?.response?.data?.message || requestError?.message || fallback;
}

/**
 * 模型用量数据层（与桌面 pages/ModelUsage.tsx 同一套请求与状态机）：
 * - modelUsageAPI.startDashboardQuery + watchDashboardQueries 渐进汇总，切换条件时取消旧任务
 *   （cancelDashboardQuery），刷新 / 切换期间保留上一次成功快照；
 * - modelUsageAPI.scan + watchScan 扫描任务，完成后静默刷新；
 * - modelUsageAPI.breakdown 分量（复用快照终点时刻），modelUsageAPI.requests 按需读取最近明细；
 * - accountsAPI.list 仅用于把 accountRef 显示为账号名。
 *
 * 桌面页面的同名逻辑被 test/web.model-usage-*.test.js 按源码文本锁定，暂未改为调用本 hook。
 */
export function useModelUsageDashboard() {
  const [rangeMode, setRangeMode] = useState<UsageRangeMode>('today');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => buildUsageRangeByMode('today'));
  const [provider, setProvider] = useState<UsageProviderFilter>('');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelUsageModelRow[]>([]);
  const [stats, setStats] = useState<ModelUsageStats>(EMPTY_USAGE_STATS);
  const [models, setModels] = useState<ModelUsageModelRow[]>([]);
  const [sessions, setSessions] = useState<ModelUsageSessionRow[]>([]);
  const [requestUsage, setRequestUsage] = useState<ModelUsageRequestRow[]>([]);
  const [requestErrors, setRequestErrors] = useState<ModelUsageRequestRow[]>([]);
  const [requestDetailsRequested, setRequestDetailsRequested] = useState(false);
  const [requestDetailsLoading, setRequestDetailsLoading] = useState(false);
  const [requestDetailsError, setRequestDetailsError] = useState('');
  const [trend, setTrend] = useState<ModelUsageTrend>(EMPTY_USAGE_TREND);
  const [accountsByRef, setAccountsByRef] = useState<Map<string, Account>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [hasDashboardSnapshot, setHasDashboardSnapshot] = useState(false);
  const [dashboardLoadError, setDashboardLoadError] = useState('');
  const [dashboardQueryJob, setDashboardQueryJob] = useState<ModelUsageDashboardQueryJob | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanJob, setScanJob] = useState<ModelUsageScanJob | null>(null);
  const [breakdownTarget, setBreakdownTarget] = useState<UsageBreakdownTarget | null>(null);
  const [breakdown, setBreakdown] = useState<ModelUsageBreakdownResponse | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const completedScanJobIdsRef = useRef<Set<string>>(new Set());
  const completedDashboardQueryIdsRef = useRef<Set<string>>(new Set());
  const dashboardQueryJobsRef = useRef<Map<string, ModelUsageDashboardQueryJob>>(new Map());
  const activeDashboardQueryIdRef = useRef('');
  const activeDashboardQueryQuietRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const quietNextLoadRef = useRef(true);
  const refreshAfterScanRef = useRef<() => void>(() => {});
  const breakdownSequenceRef = useRef(0);
  const requestDetailsSequenceRef = useRef(0);

  const query = useMemo(() => buildUsageQuery(range, rangeMode, provider, model, 50), [model, provider, range, rangeMode]);

  const beginUsageTransition = useCallback((quiet = false) => {
    quietNextLoadRef.current = quiet;
    setLoading(true);
    setDashboardLoadError('');
    setDashboardQueryJob(null);
    breakdownSequenceRef.current += 1;
    setBreakdownTarget(null);
    setBreakdown(null);
    setBreakdownLoading(false);
  }, []);

  const cancelDashboardQuery = useCallback((jobId: string) => {
    if (!jobId) return;
    void modelUsageAPI.cancelDashboardQuery(jobId).catch(() => {});
  }, []);

  const applyDashboardQueryJob = useCallback((job: ModelUsageDashboardQueryJob) => {
    if (!job.id || job.id !== activeDashboardQueryIdRef.current) return;
    setDashboardQueryJob(job);
    if (job.dashboard) {
      setStats(job.dashboard.stats || EMPTY_USAGE_STATS);
      setModels(job.dashboard.models || []);
      setSessions(job.dashboard.sessions || []);
      setModelOptions(job.dashboard.modelOptions || []);
      setTrend(job.dashboard.trend || EMPTY_USAGE_TREND);
      setHasDashboardSnapshot(true);
      setDashboardLoadError('');
    }
    if (isUsageDashboardQueryActive(job)) {
      setLoading(true);
      return;
    }
    setLoading(false);
    if (job.status === 'succeeded') {
      setDashboardLoadError('');
      return;
    }
    if (job.status !== 'failed' || completedDashboardQueryIdsRef.current.has(job.id)) return;
    completedDashboardQueryIdsRef.current.add(job.id);
    const errorMessage = job.error || '加载模型用量失败';
    setDashboardLoadError(errorMessage);
    if (!activeDashboardQueryQuietRef.current) {
      message.error(errorMessage);
    }
  }, []);

  useEffect(() => {
    let active = true;
    accountsAPI.list()
      .then((response) => {
        if (!active) return;
        setAccountsByRef(new Map(response.accounts.map((account) => [account.accountRef, account])));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const handleDashboardQueryJob = useCallback((job: ModelUsageDashboardQueryJob) => {
    if (!job.id) return;
    dashboardQueryJobsRef.current.set(job.id, job);
    applyDashboardQueryJob(job);
  }, [applyDashboardQueryJob]);

  useEffect(() => {
    const watcher = modelUsageAPI.watchDashboardQueries({
      onJob: handleDashboardQueryJob,
      onSnapshot: (jobs) => {
        jobs.forEach((job) => dashboardQueryJobsRef.current.set(job.id, job));
        const activeJob = dashboardQueryJobsRef.current.get(activeDashboardQueryIdRef.current);
        if (activeJob) applyDashboardQueryJob(activeJob);
      }
    });
    return () => {
      watcher.close();
      const activeJobId = activeDashboardQueryIdRef.current;
      activeDashboardQueryIdRef.current = '';
      cancelDashboardQuery(activeJobId);
    };
  }, [applyDashboardQueryJob, cancelDashboardQuery, handleDashboardQueryJob]);

  const loadUsage = useCallback(async (
    nextQuery: ModelUsageQuery,
    options: { quiet?: boolean } = {}
  ) => {
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    const previousJobId = activeDashboardQueryIdRef.current;
    activeDashboardQueryIdRef.current = '';
    cancelDashboardQuery(previousJobId);
    activeDashboardQueryQuietRef.current = options.quiet !== false;
    setDashboardQueryJob(null);
    setDashboardLoadError('');
    setBreakdownTarget(null);
    setBreakdown(null);
    setLoading(true);
    try {
      const response = await modelUsageAPI.startDashboardQuery({ ...nextQuery, scan: false });
      if (loadSequence !== loadSequenceRef.current) {
        cancelDashboardQuery(response.job?.id || '');
        return;
      }
      const jobId = response.job?.id || '';
      activeDashboardQueryIdRef.current = jobId;
      const latestJob = dashboardQueryJobsRef.current.get(jobId) || response.job;
      if (latestJob) {
        dashboardQueryJobsRef.current.set(jobId, latestJob);
        applyDashboardQueryJob(latestJob);
      }
    } catch (error: unknown) {
      if (loadSequence !== loadSequenceRef.current) return;
      const errorMessage = getErrorMessage(error, '加载模型用量失败');
      setDashboardLoadError(errorMessage);
      if (!options.quiet) message.error(errorMessage);
      setLoading(false);
    }
  }, [applyDashboardQueryJob, cancelDashboardQuery]);

  useEffect(() => {
    const quiet = quietNextLoadRef.current;
    quietNextLoadRef.current = true;
    loadUsage(query, { quiet });
  }, [loadUsage, query, refreshRevision]);

  useEffect(() => {
    requestDetailsSequenceRef.current += 1;
    setRequestDetailsRequested(false);
    setRequestDetailsLoading(false);
    setRequestDetailsError('');
    setRequestUsage([]);
    setRequestErrors([]);
  }, [query, refreshRevision]);

  const loadRequestDetails = useCallback(async () => {
    const requestSequence = requestDetailsSequenceRef.current + 1;
    requestDetailsSequenceRef.current = requestSequence;
    setRequestDetailsRequested(true);
    setRequestDetailsLoading(true);
    setRequestDetailsError('');
    setRequestUsage([]);
    setRequestErrors([]);
    try {
      const response = await modelUsageAPI.requests({ ...query, limit: USAGE_REQUEST_DETAIL_LIMIT });
      if (requestSequence !== requestDetailsSequenceRef.current) return;
      setRequestUsage(response.usage || []);
      setRequestErrors(response.errors || []);
    } catch (error: unknown) {
      if (requestSequence !== requestDetailsSequenceRef.current) return;
      setRequestDetailsError(getErrorMessage(error, '加载请求明细失败'));
    } finally {
      if (requestSequence === requestDetailsSequenceRef.current) {
        setRequestDetailsLoading(false);
      }
    }
  }, [query]);

  const handleRangeChange = (value: null | [Dayjs | null, Dayjs | null]) => {
    if (!value || !value[0] || !value[1]) return;
    beginUsageTransition();
    setRangeMode('custom');
    setRange([value[0], value[1]]);
    setModel('');
  };

  const handleRangeModeChange = (value: UsageRangeMode) => {
    beginUsageTransition();
    setRangeMode(value);
    setModel('');
    if (value !== 'custom') {
      setRange(buildUsageRangeByMode(value));
    }
  };

  const handleProviderChange = (value: UsageProviderFilter) => {
    beginUsageTransition();
    setProvider(value);
    setModel('');
  };

  const handleModelChange = (value: string | undefined) => {
    beginUsageTransition();
    setModel(String(value || ''));
  };

  const requestUsageRefresh = useCallback((quiet: boolean) => {
    beginUsageTransition(quiet);
    if (rangeMode !== 'custom') setRange(buildUsageRangeByMode(rangeMode));
    setRefreshRevision((current) => current + 1);
  }, [beginUsageTransition, rangeMode]);

  const handleRefreshUsage = () => requestUsageRefresh(false);

  refreshAfterScanRef.current = () => requestUsageRefresh(true);

  const handleScanJobUpdate = useCallback((job: ModelUsageScanJob) => {
    setScanJob(job);

    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedScanJobIdsRef.current.has(job.id)) return;
    completedScanJobIdsRef.current.add(job.id);

    if (job.status === 'succeeded') {
      message.success('扫描完成');
      refreshAfterScanRef.current();
      return;
    }

    message.error(job.error || '扫描模型用量失败');
  }, []);

  useEffect(() => {
    const watcher = modelUsageAPI.watchScan({
      onSnapshot: (jobs) => {
        const sorted = [...jobs].sort((left, right) => {
          const leftAt = Number(left.finishedAt || left.startedAt || 0);
          const rightAt = Number(right.finishedAt || right.startedAt || 0);
          return rightAt - leftAt;
        });
        const latest = sorted.find(isUsageScanJobActive) || sorted[0] || null;
        if (!latest) return;
        setScanJob(latest);
      },
      onJob: handleScanJobUpdate
    });
    return () => {
      watcher.close();
    };
  }, [handleScanJobUpdate]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const response = await modelUsageAPI.scan(provider);
      if (response.job) {
        setScanJob(response.job);
      }
      message.info(response.alreadyRunning ? '扫描已在进行' : '扫描已开始');
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '扫描模型用量失败'));
    } finally {
      setScanning(false);
    }
  };

  const openBreakdown = useCallback(async (target: UsageBreakdownTarget) => {
    if (loading) return;
    const sequence = breakdownSequenceRef.current + 1;
    breakdownSequenceRef.current = sequence;
    setBreakdownTarget(target);
    setBreakdown(null);
    setBreakdownLoading(true);
    try {
      const response = await modelUsageAPI.breakdown({
        ...query,
        provider: target.row.provider,
        model: target.kind === 'model' ? target.row.model : query.model,
        sessionId: target.kind === 'session' ? target.row.sessionId : '',
        limit: 500
      });
      if (sequence === breakdownSequenceRef.current) setBreakdown(response);
    } catch (error: unknown) {
      if (sequence === breakdownSequenceRef.current) {
        message.error(getErrorMessage(error, '加载用量分量失败'));
      }
    } finally {
      if (sequence === breakdownSequenceRef.current) setBreakdownLoading(false);
    }
  }, [loading, query]);

  const closeBreakdown = () => {
    breakdownSequenceRef.current += 1;
    setBreakdownTarget(null);
    setBreakdown(null);
    setBreakdownLoading(false);
  };

  const modelSelectOptions = useMemo(() => {
    const grouped = new Map<string, Set<Provider>>();
    modelOptions.forEach((item) => {
      const modelName = String(item.model || '').trim();
      if (!modelName) return;
      if (!grouped.has(modelName)) grouped.set(modelName, new Set());
      grouped.get(modelName)?.add(item.provider);
    });
    return Array.from(grouped.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([modelName, providers]) => {
        const suffix = provider
          ? ''
          : ` · ${Array.from(providers).map((item) => providerNames[item] || item).join('/')}`;
        return {
          label: `${modelName}${suffix}`,
          value: modelName
        };
      });
  }, [modelOptions, provider]);

  const dashboardProgress = dashboardQueryJob && dashboardQueryJob.totalShards > 0
    ? `${dashboardQueryJob.completedShards}/${dashboardQueryJob.totalShards}`
    : '';
  const dashboardStatusText = loading
    ? [
      hasDashboardSnapshot ? '正在切换数据范围' : '正在加载模型用量',
      dashboardProgress ? `已汇总 ${dashboardProgress}` : ''
    ].filter(Boolean).join(' · ')
    : dashboardLoadError
      ? hasDashboardSnapshot ? '切换失败，仍显示上一次成功快照' : '加载失败，请重试'
      : '';

  return {
    rangeMode,
    range,
    provider,
    model,
    query,
    stats,
    models,
    sessions,
    trend,
    accountsByRef,
    loading,
    hasDashboardSnapshot,
    dashboardLoadError,
    dashboardStatusText,
    modelSelectOptions,
    totalCacheTokens: getCacheTokens(stats),
    overallCacheHitRate: calculateCacheHitRate(stats),
    scanning,
    scanActive: scanning || isUsageScanJobActive(scanJob),
    breakdownTarget,
    breakdown,
    breakdownLoading,
    requestUsage,
    requestErrors,
    requestDetailsRequested,
    requestDetailsLoading,
    requestDetailsError,
    requestDetailLimit: USAGE_REQUEST_DETAIL_LIMIT,
    handleRangeChange,
    handleRangeModeChange,
    handleProviderChange,
    handleModelChange,
    handleRefreshUsage,
    handleScan,
    openBreakdown,
    closeBreakdown,
    loadRequestDetails
  };
}
