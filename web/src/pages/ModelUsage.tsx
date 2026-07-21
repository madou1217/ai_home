import { StatisticCard } from '@ant-design/pro-components';
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
import { modelUsageAPI } from '@/services/api';
import type {
  ModelUsageModelRow,
  ModelUsageQuery,
  ModelUsageScanJob,
  ModelUsageSessionDetailRow,
  ModelUsageSessionRow,
  ModelUsageStats,
  Provider
} from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import MobileStatGrid from '@/components/mobile/MobileStatGrid';
import MobilePills from '@/components/mobile/MobilePills';
import '@/components/mobile/mobile-cards.css';

const { RangePicker } = DatePicker;
const { Text } = Typography;

type ProviderFilter = Provider | '';
type RangeMode = 'hour' | 'today' | '7d' | 'month' | 'custom';

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

function formatTokens(value: number) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function formatCost(value: number) {
  const number = Number(value) || 0;
  if (number <= 0) return '$0.0000';
  if (number < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(2)}`;
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

function isScanJobActive(job: ModelUsageScanJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function getSessionKey(row: ModelUsageSessionRow) {
  return `${row.provider}:${row.sessionId}`;
}

function buildQuery(
  range: [Dayjs, Dayjs],
  rangeMode: RangeMode,
  provider: ProviderFilter,
  model: string,
  limit = 50,
  scan = false
): ModelUsageQuery {
  const includeTime = rangeMode === 'hour' || rangeMode === 'custom';
  return {
    from: includeTime ? formatDateTime(range[0]) : formatDate(range[0]),
    to: includeTime ? formatDateTime(range[1]) : formatDate(range[1]),
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
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanJob, setScanJob] = useState<ModelUsageScanJob | null>(null);
  const [selectedSession, setSelectedSession] = useState<ModelUsageSessionRow | null>(null);
  const [sessionDetail, setSessionDetail] = useState<ModelUsageSessionDetailRow[]>([]);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const completedScanJobIdsRef = useRef<Set<string>>(new Set());
  const loadSequenceRef = useRef(0);
  const quietNextLoadRef = useRef(true);
  const refreshAfterScanRef = useRef<() => void>(() => {});

  const query = useMemo(() => buildQuery(range, rangeMode, provider, model, 50), [model, provider, range, rangeMode]);

  const loadUsage = useCallback(async (
    nextQuery: ModelUsageQuery,
    options: { quiet?: boolean } = {}
  ) => {
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    setLoading(true);
    try {
      const response = await modelUsageAPI.dashboard({ ...nextQuery, scan: false });
      if (loadSequence !== loadSequenceRef.current) return;
      setStats(response.stats || emptyStats);
      setModels(response.models || []);
      setSessions(response.sessions || []);
      setModelOptions(response.modelOptions || []);
    } catch (error: any) {
      if (loadSequence === loadSequenceRef.current && !options.quiet) {
        message.error(error?.response?.data?.message || error?.message || '加载模型用量失败');
      }
    } finally {
      if (loadSequence === loadSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const quiet = quietNextLoadRef.current;
    quietNextLoadRef.current = true;
    loadUsage(query, { quiet });
  }, [loadUsage, query, refreshRevision]);

  const handleRangeChange = (value: null | [Dayjs | null, Dayjs | null]) => {
    if (!value || !value[0] || !value[1]) return;
    setRangeMode('custom');
    setRange([value[0], value[1]]);
    setModel('');
  };

  const handleRangeModeChange = (value: RangeMode) => {
    setRangeMode(value);
    setModel('');
    if (value !== 'custom') {
      setRange(buildRangeByMode(value));
    }
  };

  const handleProviderChange = (value: ProviderFilter) => {
    setProvider(value);
    setModel('');
  };

  const requestUsageRefresh = useCallback((quiet: boolean) => {
    quietNextLoadRef.current = quiet;
    if (rangeMode !== 'custom') setRange(buildRangeByMode(rangeMode));
    setRefreshRevision((current) => current + 1);
  }, [rangeMode]);

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

  const openSessionDetail = async (row: ModelUsageSessionRow) => {
    setSelectedSession(row);
    setSessionDetail([]);
    setSessionDetailLoading(true);
    try {
      const response = await modelUsageAPI.sessionDetail({
        ...query,
        provider: row.provider,
        sessionId: row.sessionId
      });
      setSessionDetail(response.session || []);
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '加载会话明细失败');
    } finally {
      setSessionDetailLoading(false);
    }
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
      width: 130,
      render: (value: any) => formatProvider(value as Provider)
    },
    {
      title: '模型',
      dataIndex: 'model',
      ellipsis: true,
      render: (value: any) => value || '-'
    },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 90,
      align: 'right'
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: 'Cache',
      width: 110,
      align: 'right',
      render: (_, row: any) => formatTokens(row.cacheReadInputTokens + row.cacheCreationInputTokens)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: any) => formatCost(value)
    }
  ];

  const sessionColumns: ProColumns<ModelUsageSessionRow>[] = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 130,
      render: (value: any) => formatProvider(value as Provider)
    },
    {
      title: '会话',
      dataIndex: 'sessionId',
      ellipsis: true,
      render: (value: any) => (
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
      width: 170,
      ellipsis: true,
      render: (value: any) => value || '-'
    },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 90,
      align: 'right'
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: any) => formatCost(value)
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAtMs',
      width: 130,
      render: (value: any) => formatTime(value)
    },
    {
      title: '',
      key: 'action',
      width: 56,
      align: 'center',
      render: (_, row: any) => (
        <Button
          aria-label="查看会话明细"
          icon={<EyeOutlined />}
          size="small"
          onClick={() => openSessionDetail(row as ModelUsageSessionRow)}
        />
      )
    }
  ];

  const detailColumns: ProColumns<ModelUsageSessionDetailRow>[] = [
    {
      title: '模型',
      dataIndex: 'model',
      ellipsis: true,
      render: (value: any) => value || '-'
    },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 90,
      align: 'right'
    },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 110,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: 'Cache',
      width: 110,
      align: 'right',
      render: (_, row: any) => formatTokens(row.cacheReadInputTokens + row.cacheCreationInputTokens)
    },
    {
      title: 'Reasoning',
      dataIndex: 'reasoningOutputTokens',
      width: 120,
      align: 'right',
      render: (value: any) => formatTokens(value)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: any) => formatCost(value)
    }
  ];

  // 移动端：把「按模型 / 按会话」宽表的每一行竖排成一张卡（§2 表格→卡片列表）。
  const renderModelCard = (row: ModelUsageModelRow) => (
    <div className="mobile-card" key={`${row.provider}:${row.model || 'unknown'}`}>
      <div className="mobile-card-head">
        <span className="mobile-card-head-icon"><ProviderIcon provider={row.provider} size={20} /></span>
        <div className="mobile-card-head-main">
          <div className="mobile-card-title"><span className="mobile-card-title-text">{row.model || '未知模型'}</span></div>
          <div className="mobile-card-subtitle">{providerNames[row.provider] || row.provider}</div>
        </div>
      </div>
      {/* 移动端简版:只留 调用/Tokens/成本,Input/Output 细分留桌面 */}
      <div className="mobile-card-meta">
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">调用</span><span className="mobile-card-meta-value">{row.calls}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Tokens</span><span className="mobile-card-meta-value">{formatTokens(row.totalTokens)}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">成本</span><span className="mobile-card-meta-value" style={{ color: 'var(--m-run, #13a65a)' }}>{formatCost(row.costUsd)}</span></div>
      </div>
    </div>
  );

  const renderSessionCard = (row: ModelUsageSessionRow) => (
    <div
      className="mobile-card"
      key={getSessionKey(row)}
      role="button"
      tabIndex={0}
      onClick={() => openSessionDetail(row)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSessionDetail(row); } }}
    >
      <div className="mobile-card-head">
        <span className="mobile-card-head-icon"><ProviderIcon provider={row.provider} size={20} /></span>
        <div className="mobile-card-head-main">
          <div className="mobile-card-title"><span className="mobile-card-title-text">{row.project || row.sessionId}</span></div>
          <div className="mobile-card-subtitle">{providerNames[row.provider] || row.provider} · {formatTime(row.updatedAtMs)}</div>
        </div>
        <div className="mobile-card-head-action"><Button type="text" icon={<EyeOutlined />} aria-label="查看会话明细" /></div>
      </div>
      <div className="mobile-card-meta">
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">调用</span><span className="mobile-card-meta-value">{row.calls}</span></div>
        <div className="mobile-card-meta-item"><span className="mobile-card-meta-label">Tokens</span><span className="mobile-card-meta-value">{formatTokens(row.totalTokens)}</span></div>
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
      {/* 4 项关键指标。移动端用 MobileStatGrid（2 列，数值不换行）；桌面保留 StatisticCard.Group。 */}
      {isMobile ? (
        <MobileStatGrid
          items={[
            { key: 'calls', label: '总调用次数', value: stats.totalCalls },
            { key: 'sessions', label: '运行会话', value: stats.totalSessions },
            { key: 'tokens', label: '总 Tokens', value: formatTokens(stats.totalTokens) },
            { key: 'cost', label: '估算成本 (USD)', value: formatCost(stats.totalCostUsd), valueColor: 'var(--color-success, #15803d)' }
          ]}
        />
      ) : (
        <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
          <StatisticCard statistic={{ title: '总调用次数', value: stats.totalCalls }} />
          <StatisticCard statistic={{ title: '运行会话', value: stats.totalSessions }} />
          <StatisticCard statistic={{ title: '总 Tokens', value: formatTokens(stats.totalTokens) }} />
          <StatisticCard statistic={{ title: '估算成本 (USD)', value: formatCost(stats.totalCostUsd), valueStyle: { color: 'var(--color-success, #15803d)' } }} />
        </StatisticCard.Group>
      )}

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
              value={model || undefined} onChange={(value) => setModel(String(value || ''))}
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
            onChange={(value) => setModel(String(value || ''))}
            style={{ width: 260 }}
            options={modelSelectOptions}
          />
          <Button icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
            查询
          </Button>
        </Space>
      </SectionCard>
      )}

      {isMobile ? (
        <>
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
        </>
      ) : (
      <SectionCard>
        <Tabs
          items={[
            {
              key: 'model',
              label: '按模型',
              children: (
                <ListTable<ModelUsageModelRow>
                  loading={loading}
                  rowKey={(row) => `${row.provider}:${row.model || 'unknown'}`}
                  columns={modelColumns}
                  dataSource={models}
                  scroll={{ x: 900 }}
                />
              )
            },
            {
              key: 'session',
              label: '按会话',
              children: (
                <ListTable<ModelUsageSessionRow>
                  loading={loading}
                  rowKey={getSessionKey}
                  columns={sessionColumns}
                  dataSource={sessions}
                  scroll={{ x: 1000 }}
                />
              )
            }
          ]}
        />
      </SectionCard>
      )}

      <Drawer
        title={selectedSession ? `${providerNames[selectedSession.provider]} · ${selectedSession.project || selectedSession.sessionId}` : '会话明细'}
        open={Boolean(selectedSession)}
        onClose={() => setSelectedSession(null)}
        width={isMobile ? '100%' : 760}
      >
        {selectedSession ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text code>{selectedSession.sessionId}</Text>
            {selectedSession.cwd ? <Text type="secondary">{selectedSession.cwd}</Text> : null}
            <ListTable<ModelUsageSessionDetailRow>
              loading={sessionDetailLoading}
              rowKey={(row) => `${row.provider}:${row.sessionId}:${row.model || 'unknown'}`}
              columns={detailColumns}
              dataSource={sessionDetail}
              scroll={{ x: 760 }}
            />
          </Space>
        ) : null}
      </Drawer>
    </PageScaffold>
  );
}
