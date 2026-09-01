import './ModelUsage.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DatePicker,
  Drawer,
  Grid,
  Segmented,
  Select,
  Space,
  Tabs,
  Tooltip,
  Typography,
  Empty,
  Spin,
  message
} from 'antd';
import { ProColumns } from '@ant-design/pro-components';
import {
  CopyOutlined,
  EyeOutlined,
  ReloadOutlined,
  SyncOutlined,
  FilterOutlined
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
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
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import MobilePills from '@/components/mobile/MobilePills';
import '@/components/mobile/mobile-cards.css';
import UsageTrendChart from '@/features/model-usage/UsageTrendChart';
import UsageModelMixChart from '@/features/model-usage/UsageModelMixChart';
import RequestDetailsSection from '@/features/model-usage/RequestDetailsSection';
import UsageBreakdownDrawer, {
  type UsageBreakdownTarget
} from '@/features/model-usage/UsageBreakdownDrawer';
import {
  calculateCacheHitRate,
  formatAccountScope,
  formatCacheRate,
  formatCost,
  formatTokens,
  getCacheTokens
} from '@/features/model-usage/model-usage-presentation';

const { RangePicker } = DatePicker;
const { Text } = Typography;

type ProviderFilter = Provider | '';
type RangeMode = 'hour' | 'today' | '7d' | 'month' | 'custom';

const REQUEST_DETAIL_LIMIT = 80;

const PROVIDER_OPTIONS: Array<{ label: string; value: ProviderFilter }> = [
  { label: '全部', value: '' },
  ...providerIds.map((provider) => ({ label: providerNames[provider], value: provider }))
];

const RANGE_OPTIONS: Array<{ label: string; value: RangeMode }> = [
  { label: '1 小时', value: 'hour' },
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '一个月', value: 'month' },
  { label: '自定义', value: 'custom' }
];

const emptyStats: ModelUsageStats = {
  totalCalls: 0,
  totalSessions: 0,
  totalPrompts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0
};

const emptyTrend: ModelUsageTrend = {
  fromMs: 0,
  toMs: 0,
  bucketMs: 0,
  points: []
};

function formatDate(value: Dayjs) {
  return value.format('YYYY-MM-DD');
}

function formatDateTime(value: Dayjs) {
  return value.format('YYYY-MM-DDTHH:mm:ssZ');
}

function buildRangeByMode(mode: RangeMode): [Dayjs, Dayjs] {
  const now = dayjs();
  if (mode === 'hour') return [now.subtract(1, 'hour'), now];
  if (mode === '7d') return [now.subtract(6, 'day').startOf('day'), now];
  if (mode === 'month') return [now.subtract(1, 'month').startOf('day'), now];
  return [now.startOf('day'), now];
}

function formatTime(value: number) {
  if (!value) return '-';
  return dayjs(value).format('MM-DD HH:mm');
}

function formatProvider(provider: Provider) {
  return (
    <Space size={6}>
      <ProviderIcon provider={provider} size={14} />
      <span>{providerNames[provider] || provider}</span>
    </Space>
  );
}

function renderAccountScope(accountCount: number, unattributedCalls: number) {
  const value = formatAccountScope(accountCount, unattributedCalls);
  if (unattributedCalls <= 0) return value;
  return (
    <Tooltip title="未归属部分缺少可审计账号证据，不按默认账号、时间或调度结果猜测。">
      <span>{value}</span>
    </Tooltip>
  );
}

function renderCacheTokens(row: {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}) {
  return (
    <Tooltip title={`读取 ${formatTokens(row.cacheReadInputTokens)} · 写入 ${formatTokens(row.cacheCreationInputTokens)}`}>
      <span>{formatTokens(getCacheTokens(row))}</span>
    </Tooltip>
  );
}

function isScanJobActive(job: ModelUsageScanJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function isDashboardQueryActive(job: ModelUsageDashboardQueryJob | null) {
  return Boolean(job && ['queued', 'preparing', 'running'].includes(job.status));
}

function getSessionKey(row: ModelUsageSessionRow) {
  return `${row.provider}:${row.sessionId}`;
}

function getRequestDetailsError(error: unknown) {
  const requestError = error as {
    message?: string;
    response?: { data?: { message?: string } };
  };
  return requestError?.response?.data?.message
    || requestError?.message
    || '加载请求明细失败';
}

function buildQuery(
  range: [Dayjs, Dayjs],
  rangeMode: RangeMode,
  provider: ProviderFilter,
  model: string,
  limit = 50,
  scan = false
): ModelUsageQuery {
  const includeStartTime = rangeMode === 'hour' || rangeMode === 'custom';
  return {
    from: includeStartTime ? formatDateTime(range[0]) : formatDate(range[0]),
    to: formatDateTime(range[1]),
    provider,
    model: model.trim(),
    limit,
    scan
  };
}

export default function ModelUsage() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [rangeMode, setRangeMode] = useState<RangeMode>('today');
  const [usageTab, setUsageTab] = useState<'model' | 'session'>('model');
  const [filterOpen, setFilterOpen] = useState(false);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => buildRangeByMode('today'));
  const [provider, setProvider] = useState<ProviderFilter>('');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelUsageModelRow[]>([]);
  const [stats, setStats] = useState<ModelUsageStats>(emptyStats);
  const [models, setModels] = useState<ModelUsageModelRow[]>([]);
  const [sessions, setSessions] = useState<ModelUsageSessionRow[]>([]);
  const [requestUsage, setRequestUsage] = useState<ModelUsageRequestRow[]>([]);
  const [requestErrors, setRequestErrors] = useState<ModelUsageRequestRow[]>([]);
  const [requestDetailsRequested, setRequestDetailsRequested] = useState(false);
  const [requestDetailsLoading, setRequestDetailsLoading] = useState(false);
  const [requestDetailsError, setRequestDetailsError] = useState('');
  const [trend, setTrend] = useState<ModelUsageTrend>(emptyTrend);
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

  const query = useMemo(() => buildQuery(range, rangeMode, provider, model, 50), [model, provider, range, rangeMode]);

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
      setStats(job.dashboard.stats || emptyStats);
      setModels(job.dashboard.models || []);
      setSessions(job.dashboard.sessions || []);
      setModelOptions(job.dashboard.modelOptions || []);
      setTrend(job.dashboard.trend || emptyTrend);
      setHasDashboardSnapshot(true);
      setDashboardLoadError('');
    }
    if (isDashboardQueryActive(job)) {
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
    } catch (error: any) {
      if (loadSequence !== loadSequenceRef.current) return;
      const errorMessage = error?.response?.data?.message || error?.message || '加载模型用量失败';
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
      const response = await modelUsageAPI.requests({ ...query, limit: REQUEST_DETAIL_LIMIT });
      if (requestSequence !== requestDetailsSequenceRef.current) return;
      setRequestUsage(response.usage || []);
      setRequestErrors(response.errors || []);
    } catch (error: unknown) {
      if (requestSequence !== requestDetailsSequenceRef.current) return;
      setRequestDetailsError(getRequestDetailsError(error));
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

  const handleRangeModeChange = (value: RangeMode) => {
    beginUsageTransition();
    setRangeMode(value);
    setModel('');
    if (value !== 'custom') {
      setRange(buildRangeByMode(value));
    }
  };

  const handleProviderChange = (value: ProviderFilter) => {
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
    if (rangeMode !== 'custom') setRange(buildRangeByMode(rangeMode));
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
        const latest = sorted.find(isScanJobActive) || sorted[0] || null;
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
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '扫描模型用量失败');
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
    } catch (error: any) {
      if (sequence === breakdownSequenceRef.current) {
        message.error(error?.response?.data?.message || error?.message || '加载用量分量失败');
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

  const copySessionId = async (sessionId: string) => {
    const value = String(sessionId || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      message.success('会话 ID 已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const modelColumns: ProColumns<ModelUsageModelRow>[] = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 124,
      render: (value) => formatProvider(value as Provider)
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 220,
      ellipsis: true,
      render: (value) => value || '-'
    },
    {
      title: '账号',
      key: 'accounts',
      width: 138,
      render: (_, row) => renderAccountScope(row.accountCount, row.unattributedCalls)
    },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 78,
      align: 'right'
    },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Cache',
      key: 'cache',
      width: 96,
      align: 'right',
      render: (_, row) => renderCacheTokens(row)
    },
    {
      title: '缓存率',
      dataIndex: 'cacheHitRate',
      width: 88,
      align: 'right',
      render: (value) => formatCacheRate(value as number | null)
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 100,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 96,
      align: 'right',
      render: (value) => formatCost(Number(value))
    },
    {
      title: '',
      key: 'action',
      width: 52,
      align: 'center',
      render: (_, row) => (
        <Button
          aria-label={`查看 ${row.model || '未知模型'} 的账号分量`}
          icon={<EyeOutlined />}
          size="small"
          onClick={() => void openBreakdown({ kind: 'model', row })}
        />
      )
    }
  ];

  const sessionColumns: ProColumns<ModelUsageSessionRow>[] = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 124,
      render: (value) => formatProvider(value as Provider)
    },
    {
      title: '会话',
      dataIndex: 'sessionId',
      width: 250,
      ellipsis: true,
      render: (value) => (
        <span className="usage-session-cell">
          <span className="usage-session-id" title={String(value || '')}>{value}</span>
          <Tooltip title="复制会话 ID">
            <Button
              className="copy-icon-btn"
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copySessionId(String(value || ''))}
            />
          </Tooltip>
        </span>
      )
    },
    {
      title: '项目',
      dataIndex: 'project',
      width: 150,
      ellipsis: true,
      render: (value) => value || '-'
    },
    {
      title: '账号',
      key: 'accounts',
      width: 138,
      render: (_, row) => renderAccountScope(row.accountCount, row.unattributedCalls)
    },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 78,
      align: 'right'
    },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Cache',
      key: 'cache',
      width: 96,
      align: 'right',
      render: (_, row) => renderCacheTokens(row)
    },
    {
      title: '缓存率',
      dataIndex: 'cacheHitRate',
      width: 88,
      align: 'right',
      render: (value) => formatCacheRate(value as number | null)
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 100,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 96,
      align: 'right',
      render: (value) => formatCost(Number(value))
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAtMs',
      width: 124,
      render: (value) => formatTime(Number(value))
    },
    {
      title: '',
      key: 'action',
      width: 56,
      align: 'center',
      render: (_, row) => (
        <Button
          aria-label="查看会话账号与模型分量"
          icon={<EyeOutlined />}
          size="small"
          onClick={() => void openBreakdown({ kind: 'session', row })}
        />
      )
    }
  ];

  // 移动端把宽表降级为可点击卡片，同时保留完整审计指标。
  const renderModelCard = (row: ModelUsageModelRow) => (
    <div
      className="mobile-card usage-mobile-card"
      key={`${row.provider}:${row.model || 'unknown'}`}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${row.model || '未知模型'} 的账号分量`}
      onClick={() => void openBreakdown({ kind: 'model', row })}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void openBreakdown({ kind: 'model', row });
      }}
    >
      <div className="mobile-card-head">
        <span className="mobile-card-head-icon"><ProviderIcon provider={row.provider} size={20} /></span>
        <div className="mobile-card-head-main">
          <div className="mobile-card-title"><span className="mobile-card-title-text">{row.model || '未知模型'}</span></div>
          <div className="mobile-card-subtitle">
            {providerNames[row.provider] || row.provider} · {renderAccountScope(row.accountCount, row.unattributedCalls)} · {row.calls} 次调用
          </div>
        </div>
        <span className="usage-mobile-card-action" aria-hidden><EyeOutlined /></span>
      </div>
      <div className="mobile-card-meta">
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Tokens</span><span className="mobile-card-meta-value">{formatTokens(row.totalTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Input</span><span className="mobile-card-meta-value">{formatTokens(row.inputTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Output</span><span className="mobile-card-meta-value">{formatTokens(row.outputTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Cache</span><span className="mobile-card-meta-value">{formatTokens(getCacheTokens(row))}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">缓存率</span><span className="mobile-card-meta-value">{formatCacheRate(row.cacheHitRate)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">成本</span><span className="mobile-card-meta-value" style={{ color: 'var(--hos-mobile-run, #13a65a)' }}>{formatCost(row.costUsd)}</span></div>
      </div>
    </div>
  );

  const renderSessionCard = (row: ModelUsageSessionRow) => (
    <div
      className="mobile-card usage-mobile-card"
      key={getSessionKey(row)}
      role="button"
      tabIndex={0}
      aria-label={`查看会话 ${row.project || row.sessionId} 的账号与模型分量`}
      onClick={() => void openBreakdown({ kind: 'session', row })}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void openBreakdown({ kind: 'session', row });
      }}
    >
      <div className="mobile-card-head">
        <span className="mobile-card-head-icon"><ProviderIcon provider={row.provider} size={20} /></span>
        <div className="mobile-card-head-main">
          <div className="mobile-card-title"><span className="mobile-card-title-text">{row.project || row.sessionId}</span></div>
          <div className="mobile-card-subtitle">
            {providerNames[row.provider] || row.provider} · {renderAccountScope(row.accountCount, row.unattributedCalls)} · {formatTime(row.updatedAtMs)}
          </div>
        </div>
        <span className="usage-mobile-card-action" aria-hidden><EyeOutlined /></span>
      </div>
      <div className="mobile-card-meta">
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Tokens</span><span className="mobile-card-meta-value">{formatTokens(row.totalTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Input</span><span className="mobile-card-meta-value">{formatTokens(row.inputTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Output</span><span className="mobile-card-meta-value">{formatTokens(row.outputTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Cache</span><span className="mobile-card-meta-value">{formatTokens(getCacheTokens(row))}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">缓存率</span><span className="mobile-card-meta-value">{formatCacheRate(row.cacheHitRate)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">成本</span><span className="mobile-card-meta-value" style={{ color: 'var(--color-success, #15803d)' }}>{formatCost(row.costUsd)}</span></div>
      </div>
    </div>
  );

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

  const totalCacheTokens = getCacheTokens(stats);
  const overallCacheHitRate = calculateCacheHitRate(stats);
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
  const dashboardBodyClassName = [
    'usage-dashboard-body',
    loading ? 'usage-dashboard-body--loading' : '',
    loading && hasDashboardSnapshot ? 'usage-dashboard-body--refreshing' : '',
    dashboardLoadError ? 'usage-dashboard-body--error' : ''
  ].filter(Boolean).join(' ');

  return (
    <PageScaffold ghost
      title="模型用量统计"
      subTitle="监控 Tokens、会话、模型调用频次和估算成本。"
      extra={isMobile ? (
        <div className="m-header-actions">
          <button className="m-icon-btn" aria-label="刷新" onClick={handleRefreshUsage} disabled={loading}><ReloadOutlined spin={loading} /></button>
          <button className="m-icon-btn primary" aria-label="扫描" onClick={handleScan} disabled={scanning || isScanJobActive(scanJob)}><SyncOutlined spin={scanning || isScanJobActive(scanJob)} /></button>
        </div>
      ) : [
        <Button key="refresh" icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
          刷新
        </Button>,
        <Button key="scan" type="primary" icon={<SyncOutlined />} onClick={handleScan} loading={scanning || isScanJobActive(scanJob)}>
          扫描
        </Button>
      ]}
    >
      <div className={dashboardBodyClassName} aria-busy={loading}>
      <div
        className={`usage-query-progress${dashboardStatusText ? ' usage-query-progress--visible' : ''}${dashboardLoadError && !loading ? ' usage-query-progress--error' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading ? <SyncOutlined spin aria-hidden /> : null}
        {dashboardStatusText ? (
          <Text type={dashboardLoadError && !loading ? 'danger' : 'secondary'}>
            {dashboardStatusText}
          </Text>
        ) : null}
      </div>

      <section className="usage-kpi-rail" aria-label="核心用量指标">
        <div className="usage-kpi-item usage-kpi-item--primary">
          <span>总 Tokens</span>
          <strong>{formatTokens(stats.totalTokens)}</strong>
          <small>{stats.totalCalls} 次调用 · {stats.totalSessions} 个会话</small>
        </div>
        <div className="usage-kpi-item">
          <span>Input</span>
          <strong>{formatTokens(stats.inputTokens)}</strong>
          <small>未含缓存读写</small>
        </div>
        <div className="usage-kpi-item">
          <span>Output</span>
          <strong>{formatTokens(stats.outputTokens)}</strong>
          <small>推理 {formatTokens(stats.reasoningOutputTokens)}</small>
        </div>
        <div className="usage-kpi-item">
          <span>Cache</span>
          <strong>{formatTokens(totalCacheTokens)}</strong>
          <small>读 {formatTokens(stats.cacheReadInputTokens)} · 写 {formatTokens(stats.cacheCreationInputTokens)}</small>
        </div>
        <div className="usage-kpi-item">
          <span>缓存率</span>
          <strong>{formatCacheRate(overallCacheHitRate)}</strong>
          <small>读取 / 全部输入侧 Tokens</small>
        </div>
        <div className="usage-kpi-item usage-kpi-item--cost">
          <span>估算成本</span>
          <strong>{formatCost(stats.totalCostUsd)}</strong>
          <small>USD · 按当前价格快照</small>
        </div>
      </section>

      {isMobile ? (
        <>
          {/* 原生:一个「筛选」按钮 → 底部抽屉,不在主屏平铺 pills */}
          <div className="m-filterbar">
            <button className="m-filter-btn" onClick={() => setFilterOpen(true)}>
              <FilterOutlined />
              <span>筛选</span>
              <span className="m-filter-summary">
                {(RANGE_OPTIONS.find((o) => o.value === rangeMode)?.label) as string}
                {' · '}
                {(PROVIDER_OPTIONS.find((o) => o.value === provider)?.label) as string}
                {model ? ` · ${model}` : ''}
              </span>
            </button>
          </div>
          <Drawer
            title="筛选" placement="bottom" height="auto" open={filterOpen}
            onClose={() => setFilterOpen(false)} className="m-filter-drawer"
          >
            <div className="m-filter-group-label">时间范围</div>
            <MobilePills
              wrap
              items={RANGE_OPTIONS.map((o) => ({ key: String(o.value), label: o.label }))}
              activeKey={rangeMode}
              onChange={(key) => handleRangeModeChange(key as RangeMode)}
            />
            {rangeMode === 'custom' ? (
              <RangePicker
                value={range}
                onChange={handleRangeChange}
                allowClear={false}
                style={{ width: '100%', marginBottom: 13 }}
                disabledDate={(current) => Boolean(current && current > dayjs().endOf('day'))}
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
              />
            ) : null}
            <div className="m-filter-group-label">来源</div>
            <MobilePills
              wrap
              items={PROVIDER_OPTIONS.map((o) => ({ key: String(o.value), label: o.label }))}
              activeKey={provider}
              onChange={(key) => handleProviderChange(key as ProviderFilter)}
            />
            <div className="m-filter-group-label">模型</div>
            <Select
              allowClear showSearch optionFilterProp="label" placeholder="全部模型"
              value={model || undefined} onChange={handleModelChange}
              style={{ width: '100%' }} options={modelSelectOptions}
            />
          </Drawer>
        </>
      ) : (
      <SectionCard bordered >
        <Space size={12} wrap>
          <Segmented
            value={rangeMode}
            options={RANGE_OPTIONS}
            onChange={(value) => handleRangeModeChange(value as RangeMode)}
          />
          {rangeMode === 'custom' ? (
            <RangePicker
              value={range}
              onChange={handleRangeChange}
              allowClear={false}
              disabledDate={(current) => Boolean(current && current > dayjs().endOf('day'))}
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
            />
          ) : null}
          <Segmented
            value={provider}
            options={PROVIDER_OPTIONS}
            onChange={(value) => handleProviderChange(value as ProviderFilter)}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部模型"
            value={model || undefined}
            onChange={handleModelChange}
            style={{ width: 260 }}
            options={modelSelectOptions}
          />
          <Button icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
            查询
          </Button>
        </Space>
      </SectionCard>
      )}

      <SectionCard className="usage-insights-card" bodyStyle={{ padding: 0 }}>
        <div className="usage-insight-grid">
          <UsageTrendChart trend={trend} />
          <UsageModelMixChart
            models={models}
            onSelectModel={(row) => void openBreakdown({ kind: 'model', row })}
          />
        </div>
      </SectionCard>

      {isMobile ? (
        <div className="usage-results-mobile">
          <MobilePills
            items={[{ key: 'model', label: '按模型' }, { key: 'session', label: '按会话' }]}
            activeKey={usageTab}
            onChange={(key) => setUsageTab(key as 'model' | 'session')}
          />
          {usageTab === 'model' ? (
            loading && models.length === 0 ? (
              <div style={{ padding: '48px 0', textAlign: 'center' }}><Spin /></div>
            ) : models.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: '32px 0' }} />
            ) : (
              <div className="mobile-card-list">{models.map(renderModelCard)}</div>
            )
          ) : (
            loading && sessions.length === 0 ? (
              <div style={{ padding: '48px 0', textAlign: 'center' }}><Spin /></div>
            ) : sessions.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: '32px 0' }} />
            ) : (
              <div className="mobile-card-list">{sessions.map(renderSessionCard)}</div>
            )
          )}
        </div>
      ) : (
      <SectionCard className="usage-results-card">
        <Tabs
          activeKey={usageTab}
          onChange={(key) => setUsageTab(key as 'model' | 'session')}
          items={[
            {
              key: 'model',
              label: '按模型',
              children: (
                <ListTable<ModelUsageModelRow>
                  loading={loading && models.length === 0}
                  rowKey={(row) => `${row.provider}:${row.model || 'unknown'}`}
                  columns={modelColumns}
                  dataSource={models}
                  scroll={{ x: 1280 }}
                />
              )
            },
            {
              key: 'session',
              label: '按会话',
              children: (
                <ListTable<ModelUsageSessionRow>
                  loading={loading && sessions.length === 0}
                  rowKey={getSessionKey}
                  columns={sessionColumns}
                  dataSource={sessions}
                  scroll={{ x: 1560 }}
                />
              )
            }
          ]}
        />
      </SectionCard>
      )}

      <RequestDetailsSection
        usage={requestUsage}
        errors={requestErrors}
        requested={requestDetailsRequested}
        loading={requestDetailsLoading}
        error={requestDetailsError}
        limit={REQUEST_DETAIL_LIMIT}
        onRequest={() => void loadRequestDetails()}
      />

      <UsageBreakdownDrawer
        target={breakdownTarget}
        data={breakdown}
        loading={breakdownLoading}
        isMobile={isMobile}
        accountsByRef={accountsByRef}
        onClose={closeBreakdown}
      />
      </div>
    </PageScaffold>
  );
}
