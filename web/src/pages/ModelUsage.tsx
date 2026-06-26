import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Empty,
  Grid,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  BarChartOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DollarOutlined,
  EyeOutlined,
  ReloadOutlined,
  SyncOutlined
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { modelUsageAPI } from '@/services/api';
import type {
  ModelUsageModelRow,
  ModelUsageQuery,
  ModelUsageScanJob,
  ModelUsageScanResult,
  ModelUsageSessionDetailRow,
  ModelUsageSessionRow,
  ModelUsageStats,
  Provider
} from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import PageHero from '@/components/ui/PageHero';
import './ModelUsage.css';

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

function formatScanJobStatus(job: ModelUsageScanJob | null) {
  if (!job) return '空闲';
  if (job.status === 'queued') return '排队中';
  if (job.status === 'running') return '扫描中';
  if (job.status === 'succeeded') return '已完成';
  return '失败';
}

function formatScanJobProvider(job: ModelUsageScanJob | null) {
  if (!job || !job.provider) return '全部 provider';
  return providerNames[job.provider] || job.provider;
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
  const [scanResult, setScanResult] = useState<ModelUsageScanResult | null>(null);
  const [selectedSession, setSelectedSession] = useState<ModelUsageSessionRow | null>(null);
  const [sessionDetail, setSessionDetail] = useState<ModelUsageSessionDetailRow[]>([]);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const completedScanJobIdsRef = useRef<Set<string>>(new Set());
  const refreshAfterScanRef = useRef<() => Promise<void>>(async () => {});

  const query = useMemo(() => buildQuery(range, rangeMode, provider, model, 50), [model, provider, range, rangeMode]);
  const modelOptionsQuery = useMemo(() => buildQuery(range, rangeMode, provider, '', 500), [provider, range, rangeMode]);

  const refreshRollingRange = () => {
    const nextRange = rangeMode === 'custom' ? range : buildRangeByMode(rangeMode);
    if (rangeMode !== 'custom') {
      setRange(nextRange);
    }
    return nextRange;
  };

  const buildQueryForRange = (
    nextRange: [Dayjs, Dayjs],
    options: { limit?: number; modelValue?: string; scan?: boolean } = {}
  ) => {
    return buildQuery(
      nextRange,
      rangeMode,
      provider,
      options.modelValue ?? model,
      options.limit ?? 50,
      options.scan === true
    );
  };

  const loadUsage = async (nextQuery: ModelUsageQuery = query, options: { quiet?: boolean } = {}) => {
    setLoading(true);
    try {
      const readQuery = { ...nextQuery, scan: false };
      const nextStats = await modelUsageAPI.stats(readQuery);
      const [nextModels, nextSessions] = await Promise.all([
        modelUsageAPI.models(readQuery),
        modelUsageAPI.sessions(readQuery)
      ]);
      setStats(nextStats.stats || emptyStats);
      setModels(nextModels.models || []);
      setSessions(nextSessions.sessions || []);
    } catch (error: any) {
      if (!options.quiet) {
        message.error(error?.response?.data?.message || error?.message || '加载模型用量失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const loadModelOptions = async (nextQuery: ModelUsageQuery = modelOptionsQuery) => {
    try {
      const response = await modelUsageAPI.models(nextQuery);
      setModelOptions(response.models || []);
    } catch (_error) {
      setModelOptions([]);
    }
  };

  useEffect(() => {
    loadUsage(query, { quiet: true });
  }, [query]);

  useEffect(() => {
    loadModelOptions(modelOptionsQuery);
  }, [modelOptionsQuery]);

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

  const handleRefreshUsage = async () => {
    const nextRange = refreshRollingRange();
    const nextQuery = buildQueryForRange(nextRange);
    const nextModelOptionsQuery = buildQueryForRange(nextRange, { limit: 500, modelValue: '' });
    await loadUsage(nextQuery);
    await loadModelOptions(nextModelOptionsQuery);
  };

  refreshAfterScanRef.current = async () => {
    const nextRange = refreshRollingRange();
    const nextQuery = buildQueryForRange(nextRange);
    const nextModelOptionsQuery = buildQueryForRange(nextRange, { limit: 500, modelValue: '' });
    await Promise.all([
      loadUsage(nextQuery, { quiet: true }),
      loadModelOptions(nextModelOptionsQuery)
    ]);
  };

  const handleScanJobUpdate = useCallback((job: ModelUsageScanJob) => {
    setScanJob(job);
    if (job.result) setScanResult(job.result);

    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedScanJobIdsRef.current.has(job.id)) return;
    completedScanJobIdsRef.current.add(job.id);

    if (job.status === 'succeeded') {
      message.success('扫描完成');
      refreshAfterScanRef.current().catch(() => {});
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
        if (latest.result) setScanResult(latest.result);
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
        if (response.job.result) setScanResult(response.job.result);
      }
      if (response.result) setScanResult(response.result);
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

  const modelColumns: TableColumnsType<ModelUsageModelRow> = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 130,
      render: (value: Provider) => formatProvider(value)
    },
    {
      title: '模型',
      dataIndex: 'model',
      ellipsis: true,
      render: (value: string) => value || '-'
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
      render: (value: number) => formatTokens(value)
    },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 110,
      align: 'right',
      render: (value: number) => formatTokens(value)
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 110,
      align: 'right',
      render: (value: number) => formatTokens(value)
    },
    {
      title: 'Cache',
      width: 110,
      align: 'right',
      render: (_, row) => formatTokens(row.cacheReadInputTokens + row.cacheCreationInputTokens)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: number) => formatCost(value)
    }
  ];

  const sessionColumns: TableColumnsType<ModelUsageSessionRow> = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 130,
      render: (value: Provider) => formatProvider(value)
    },
    {
      title: '会话',
      dataIndex: 'sessionId',
      ellipsis: true,
      render: (value: string) => <Text code>{value}</Text>
    },
    {
      title: '项目',
      dataIndex: 'project',
      width: 170,
      ellipsis: true,
      render: (value: string) => value || '-'
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
      render: (value: number) => formatTokens(value)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: number) => formatCost(value)
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAtMs',
      width: 130,
      render: (value: number) => formatTime(value)
    },
    {
      title: '',
      key: 'action',
      width: 56,
      align: 'center',
      render: (_, row) => (
        <Button
          aria-label="查看会话明细"
          icon={<EyeOutlined />}
          size="small"
          onClick={() => openSessionDetail(row)}
        />
      )
    }
  ];

  const detailColumns: TableColumnsType<ModelUsageSessionDetailRow> = [
    {
      title: '模型',
      dataIndex: 'model',
      ellipsis: true,
      render: (value: string) => value || '-'
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
      render: (value: number) => formatTokens(value)
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 110,
      align: 'right',
      render: (value: number) => formatTokens(value)
    },
    {
      title: 'Cache',
      width: 110,
      align: 'right',
      render: (_, row) => formatTokens(row.cacheReadInputTokens + row.cacheCreationInputTokens)
    },
    {
      title: 'Reasoning',
      dataIndex: 'reasoningOutputTokens',
      width: 120,
      align: 'right',
      render: (value: number) => formatTokens(value)
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 110,
      align: 'right',
      render: (value: number) => formatCost(value)
    }
  ];

  const scanProviderRows = useMemo(() => {
    return Object.entries(scanResult?.providers || {}).map(([key, value]) => ({
      provider: key as Provider,
      ...value
    }));
  }, [scanResult]);

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

  if (isMobile) {
    return (
      <div className="model-usage-page" style={{ padding: '14px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 13 }}>今日使用量统计概览</Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
            刷新
          </Button>
        </div>

        {/* 4 项关键指标 2×2 */}
        <Row gutter={[10, 10]} style={{ marginBottom: 16 }}>
          <Col span={12}>
            <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 12 }}>
              <Statistic title="调用次数" value={stats.totalCalls} prefix={<BarChartOutlined style={{ color: '#1890ff' }} />} valueStyle={{ fontSize: 18 }} />
            </Card>
          </Col>
          <Col span={12}>
            <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 12 }}>
              <Statistic title="会话数" value={stats.totalSessions} prefix={<ClockCircleOutlined style={{ color: '#722ed1' }} />} valueStyle={{ fontSize: 18 }} />
            </Card>
          </Col>
          <Col span={12}>
            <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 12 }}>
              <Statistic title="Tokens总数" value={formatTokens(stats.totalTokens)} prefix={<DatabaseOutlined style={{ color: '#fa8c16' }} />} valueStyle={{ fontSize: 18 }} />
            </Card>
          </Col>
          <Col span={12}>
            <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 12 }}>
              <Statistic title="估算成本" value={formatCost(stats.totalCostUsd)} prefix={<DollarOutlined style={{ color: '#52c41a' }} />} valueStyle={{ fontSize: 18 }} />
            </Card>
          </Col>
        </Row>

        {/* 模型使用情况 */}
        <Card
          title="模型使用情况"
          style={{ borderRadius: 8, marginBottom: 16 }}
          bodyStyle={{ padding: loading ? '24px 16px' : (models.length === 0 ? '16px' : '8px 16px') }}
        >
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <Spin tip="加载中..." />
            </div>
          ) : models.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型调用数据" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {models.map((item, index) => (
                <div
                  key={`${item.provider}:${item.model || index}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 0',
                    borderBottom: index === models.length - 1 ? 'none' : '1px solid #f0f0f0'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                    <ProviderIcon provider={item.provider} size={18} />
                    <Text ellipsis style={{ fontSize: 14, fontWeight: 500 }}>
                      {item.model || '未知模型'}
                    </Text>
                  </div>
                  <div style={{ marginLeft: 16, flexShrink: 0 }}>
                    <Tag color="blue" style={{ fontSize: 13, borderRadius: 4, margin: 0 }}>
                      {item.calls} 次调用
                    </Tag>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="model-usage-page">
      <PageHero
        title="模型用量"
        description="Token、会话、模型和估算成本"
        actions={(
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<SyncOutlined />} onClick={handleScan} loading={scanning || isScanJobActive(scanJob)}>
              扫描
            </Button>
          </Space>
        )}
      />

      <Card style={{ borderRadius: 8, marginBottom: 16 }} bodyStyle={{ padding: isMobile ? 14 : 16 }}>
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
            style={{ width: isMobile ? '100%' : 260 }}
            options={modelSelectOptions}
          />
          <Button icon={<ReloadOutlined />} onClick={handleRefreshUsage} loading={loading}>
            查询
          </Button>
        </Space>
      </Card>

      {scanJob ? (
        <Card
          className={`usage-live-scan usage-live-scan--${scanJob.status} animate__animated animate__fadeIn animate__faster`}
          bodyStyle={{ padding: isMobile ? 14 : 16 }}
        >
          <div className="usage-live-scan-main">
            <div>
              <Text type="secondary">扫描状态</Text>
              <strong>{formatScanJobStatus(scanJob)}</strong>
            </div>
            <div>
              <Text type="secondary">范围</Text>
              <strong>{formatScanJobProvider(scanJob)}</strong>
            </div>
            <div>
              <Text type="secondary">记录</Text>
              <strong>{scanJob.result?.records ?? '-'}</strong>
            </div>
            <div>
              <Text type="secondary">文件</Text>
              <strong>{scanJob.result?.files ?? '-'}</strong>
            </div>
          </div>
          {scanJob.error ? <Text type="danger">{scanJob.error}</Text> : null}
        </Card>
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 16 }}>
            <Statistic title="调用" value={stats.totalCalls} prefix={<BarChartOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 16 }}>
            <Statistic title="会话" value={stats.totalSessions} prefix={<ClockCircleOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 16 }}>
            <Statistic title="Tokens" value={formatTokens(stats.totalTokens)} prefix={<DatabaseOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card style={{ borderRadius: 8 }} bodyStyle={{ padding: 16 }}>
            <Statistic title="成本" value={formatCost(stats.totalCostUsd)} prefix={<DollarOutlined />} />
          </Card>
        </Col>
      </Row>

      <Card title="按模型" style={{ borderRadius: 8, marginBottom: 16 }} bodyStyle={{ padding: 0 }}>
        <Table<ModelUsageModelRow>
          size="middle"
          loading={loading}
          rowKey={(row) => `${row.provider}:${row.model || 'unknown'}`}
          columns={modelColumns}
          dataSource={models}
          pagination={false}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无记录" /> }}
        />
      </Card>

      {scanResult ? (
        <Card title="最近扫描" style={{ borderRadius: 8, marginBottom: 16 }} bodyStyle={{ padding: 16 }}>
          <Row gutter={[24, 16]}>
            <Col xs={24} md={6} style={{ borderRight: isMobile ? 'none' : '1px solid var(--app-border, #f0f0f0)' }}>
              <div style={{ paddingBottom: isMobile ? 12 : 0, borderBottom: isMobile ? '1px solid var(--app-border, #f0f0f0)' : 'none' }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
                  扫描概览
                </Text>
                <Space direction="vertical" size={4} style={{ fontSize: 13 }}>
                  <div>扫描文件：<Text strong>{scanResult.files}</Text></div>
                  <div>调用记录：<Text strong>{scanResult.records}</Text></div>
                  <div>Prompts：<Text strong>{scanResult.prompts}</Text></div>
                </Space>
              </div>
            </Col>
            <Col xs={24} md={18}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
                按 Provider 统计
              </Text>
              <Space wrap size={12}>
                {scanProviderRows.map((item) => (
                  <div
                    key={item.provider}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 'var(--app-radius-sm, 6px)',
                      background: 'var(--app-surface-muted, #fafafa)',
                      border: '1px solid var(--app-border, #f0f0f0)',
                      minWidth: 140
                    }}
                  >
                    <div style={{ marginBottom: 4 }}>
                      {formatProvider(item.provider)}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--app-muted)' }}>
                      文件: <Text strong>{item.files}</Text> | 记录: <Text strong>{item.records}</Text>
                    </div>
                  </div>
                ))}
              </Space>
            </Col>
          </Row>
        </Card>
      ) : null}

      <Card title="按会话" style={{ borderRadius: 8 }} bodyStyle={{ padding: 0 }}>
        <Table<ModelUsageSessionRow>
          size="middle"
          loading={loading}
          rowKey={getSessionKey}
          columns={sessionColumns}
          dataSource={sessions}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          scroll={{ x: 1000 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无记录" /> }}
        />
      </Card>

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
            <Table<ModelUsageSessionDetailRow>
              size="middle"
              loading={sessionDetailLoading}
              rowKey={(row) => `${row.provider}:${row.sessionId}:${row.model || 'unknown'}`}
              columns={detailColumns}
              dataSource={sessionDetail}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无记录" /> }}
            />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
