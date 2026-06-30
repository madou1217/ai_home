import { StatisticCard } from '@ant-design/pro-components';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Alert,
  Descriptions,
  Progress,
  Row,
  Col,
  Space,
  Tag,
  Typography,
  message
} from 'antd';
import {
  CheckCircleOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  ReloadOutlined,
  SyncOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import PageScaffold from '@/components/ui/PageScaffold';
import { managementAPI } from '@/services/api';
import type { ManagementAccount, ManagementMetrics, ManagementStatus, Provider } from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import { parseUpstreamError } from '@/utils/format-upstream-error';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import '../styles/unified.css';

const PROVIDERS: Provider[] = providerIds;

const formatPercent = (value?: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;

function normalizeQueueCount(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function formatQueueSnapshot(snapshot?: ManagementStatus['queue'][string]) {
  if (!snapshot) return '-';
  const running = normalizeQueueCount(snapshot.running);
  const queued = normalizeQueueCount(snapshot.queued);
  const maxConcurrency = normalizeQueueCount(snapshot.maxConcurrency, 1);
  return `${running} 运行 / ${queued} 排队 / 并发 ${maxConcurrency}`;
}

function formatRecentErrorMessage(item: ManagementMetrics['lastErrors'][number]) {
  const msg = String(item?.message || item?.error || item?.detail || item?.reason || '').trim();
  if (msg) return msg;
  return '未提供错误详情';
}

type ProviderRow = {
  key: Provider;
  provider: Provider;
  total: number;
  active: number;
  statuses: Record<string, number>;
  queue: any;
  requests: number;
  success: number;
  failures: number;
};

function getRecentErrorProvider(item: ManagementMetrics['lastErrors'][number]) {
  const provider = String(item.provider || '').trim().toLowerCase();
  return PROVIDERS.includes(provider as Provider) ? (provider as Provider) : null;
}

function getRecentErrorAccountRef(item: ManagementMetrics['lastErrors'][number]) {
  return String(item.accountRef || '').trim();
}

function formatRecentErrorTime(value?: string) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getManagementAccountLabel(account?: ManagementAccount) {
  if (!account) return '';
  const identity = String(account.email || account.baseUrl || '').trim();
  return identity || `${providerNames[account.provider]} 账号`;
}

function buildAccountLink(provider: Provider, accountId: string) {
  const params = new URLSearchParams({ provider, accountId });
  return `/accounts?${params.toString()}`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<ManagementStatus | null>(null);
  const [metrics, setMetrics] = useState<ManagementMetrics | null>(null);
  const [accounts, setAccounts] = useState<ManagementAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [cooldownClearing, setCooldownClearing] = useState(false);
  const [liveState, setLiveState] = useState<'connecting' | 'live' | 'degraded'>('connecting');
  const [statusReceivedAt, setStatusReceivedAt] = useState(0);
  const [uptimeTickMs, setUptimeTickMs] = useState(() => Date.now());
  const snapshotReceivedAtRef = useRef(0);
  const refreshFallbackTimerRef = useRef<number | null>(null);

  function clearRefreshFallbackTimer() {
    if (refreshFallbackTimerRef.current === null) return;
    window.clearTimeout(refreshFallbackTimerRef.current);
    refreshFallbackTimerRef.current = null;
  }

  function applyDashboardSnapshot(
    nextStatus: ManagementStatus,
    nextMetrics: ManagementMetrics,
    nextAccounts: ManagementAccount[]
  ) {
    const receivedAt = Date.now();
    snapshotReceivedAtRef.current = receivedAt;
    setStatus(nextStatus);
    setMetrics(nextMetrics);
    setAccounts(nextAccounts || []);
    setStatusReceivedAt(receivedAt);
    setLiveState('live');
    setLoading(false);
    clearRefreshFallbackTimer();
  }

  const loadDashboard = useCallback(async (options: { showLoading?: boolean; quietError?: boolean } = {}) => {
    const showLoading = Boolean(options.showLoading);
    const quietError = Boolean(options.quietError);
    if (showLoading) {
      setLoading(true);
    }
    try {
      const [nextStatus, nextMetrics, nextAccounts] = await Promise.all([
        managementAPI.status(),
        managementAPI.metrics(),
        managementAPI.accounts()
      ]);
      const receivedAt = Date.now();
      snapshotReceivedAtRef.current = receivedAt;
      setStatus(nextStatus);
      setMetrics(nextMetrics);
      setAccounts(nextAccounts.accounts || []);
      setStatusReceivedAt(receivedAt);
      setLiveState('degraded');
    } catch (error: any) {
      if (!quietError) {
        message.error(error?.response?.data?.message || error?.message || '加载管理面板失败');
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    const initialFallbackTimer = window.setTimeout(() => {
      if (snapshotReceivedAtRef.current > 0) return;
      setLiveState('degraded');
      loadDashboard({ showLoading: true, quietError: true });
    }, 2500);
    const watcher = managementAPI.watch({
      onConnected: () => {
        setLiveState('connecting');
      },
      onSnapshot: ({ status: nextStatus, metrics: nextMetrics, accounts: nextAccounts }) => {
        applyDashboardSnapshot(nextStatus, nextMetrics, nextAccounts || []);
      },
      onError: () => {
        setLiveState('degraded');
        if (snapshotReceivedAtRef.current === 0) {
          loadDashboard({ showLoading: true, quietError: true });
        } else {
          setLoading(false);
        }
      }
    });
    return () => {
      window.clearTimeout(initialFallbackTimer);
      clearRefreshFallbackTimer();
      watcher.close();
    };
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setUptimeTickMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const displayedUptimeSec = useMemo(() => {
    if (typeof status?.uptimeSec !== 'number') return null;
    if (!statusReceivedAt) return status.uptimeSec;
    return status.uptimeSec + Math.max(0, Math.floor((uptimeTickMs - statusReceivedAt) / 1000));
  }, [status?.uptimeSec, statusReceivedAt, uptimeTickMs]);

  const handleClearCooldown = async () => {
    setCooldownClearing(true);
    try {
      await managementAPI.clearCooldown();
      message.success('已清空冷却状态');
      if (liveState === 'degraded') {
        await loadDashboard({ showLoading: true, quietError: true });
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '清空冷却失败');
    } finally {
      setCooldownClearing(false);
    }
  };

  const handleRefreshDashboard = async () => {
    const previousSnapshotAt = snapshotReceivedAtRef.current;
    setLoading(true);
    clearRefreshFallbackTimer();

    if (liveState === 'live' || liveState === 'connecting') {
      try {
        await managementAPI.requestSnapshot();
        refreshFallbackTimerRef.current = window.setTimeout(() => {
          if (snapshotReceivedAtRef.current > previousSnapshotAt) return;
          setLiveState('degraded');
          loadDashboard({ showLoading: true, quietError: true });
        }, 2000);
        return;
      } catch (_error) {
        setLiveState('degraded');
      }
    }

    await loadDashboard({ showLoading: true });
  };

  const providerRows = useMemo<ProviderRow[]>(() => {
    return PROVIDERS.map((provider) => {
      const providerStatus = status?.providers?.[provider];
      const providerQueue = status?.queue?.[provider];
      return {
        key: provider,
        provider,
        total: providerStatus?.total || 0,
        active: providerStatus?.active || 0,
        statuses: providerStatus?.statuses || {},
        queue: providerQueue,
        requests: metrics?.providerCounts?.[provider] || 0,
        success: metrics?.providerSuccess?.[provider] || 0,
        failures: metrics?.providerFailures?.[provider] || 0
      };
    });
  }, [metrics, status]);

  const routeRows = useMemo(() => {
    return Object.entries(metrics?.routeCounts || {})
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 8)
      .map(([route, count]) => ({
        key: route,
        route,
        count: Number(count || 0)
      }));
  }, [metrics]);

  const degradedCount = Math.max(0, Number(status?.totalAccounts || 0) - Number(status?.activeAccounts || 0));
  const recentErrors = metrics?.lastErrors || [];
  const accountByRef = useMemo(() => {
    return new Map(
      accounts
        .filter((account) => account.accountRef)
        .map((account) => [String(account.accountRef || ''), account])
    );
  }, [accounts]);

  const recentErrorRows = recentErrors.slice(0, 8).map((item, index) => ({ ...item, __key: `${item.at || 'unknown'}-${index}` }));

  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);

  const recentErrorColumns = [
    {
      title: 'Provider / 账号',
      key: 'provider',
      width: 220,
      render: (_: any, item: ManagementMetrics['lastErrors'][number]) => {
        const provider = getRecentErrorProvider(item);
        const accountRef = getRecentErrorAccountRef(item);
        const account = accountRef ? accountByRef.get(accountRef) : undefined;
        const accountId = account ? String(account.accountId || account.id || '').trim() : '';
        if (!provider) return <RuntimeStatusTag status="upstream_error" fallback="upstream" />;
        return (
          <Space size={8} wrap>
            <Space size={5}>
              <ProviderIcon provider={provider} size={15} />
              <span style={{ fontWeight: 700 }}>{providerNames[provider as keyof typeof providerNames] || provider}</span>
            </Space>
            {accountId ? (
              <a href={buildAccountLink(provider, accountId)}>{getManagementAccountLabel(account) || '查看对应账号'}</a>
            ) : null}
          </Space>
        );
      }
    },
    {
      title: 'Route',
      dataIndex: 'route',
      key: 'route',
      width: 180,
      render: (route: string) => route ? <span style={{ color: 'var(--app-muted)', fontSize: 12 }}>{route}</span> : '-'
    },
    {
      title: '错误详情',
      key: 'message',
      render: (_: any, item: ManagementMetrics['lastErrors'][number]) => {
        const parsed = parseUpstreamError(formatRecentErrorMessage(item));
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {parsed.statusCode ? <Tag color="error" style={{ marginInlineEnd: 0 }}>HTTP {parsed.statusCode}</Tag> : null}
            <Typography.Paragraph
              style={{ margin: 0, fontSize: 13 }}
              ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
            >
              {parsed.message}
            </Typography.Paragraph>
          </Space>
        );
      }
    },
    {
      title: '时间',
      dataIndex: 'at',
      key: 'at',
      width: 120,
      render: (at: string) => <span style={{ color: 'var(--app-muted)', fontSize: 12 }}>{formatRecentErrorTime(at)}</span>
    }
  ];

  const routeColumns = [
    {
      title: 'Route',
      dataIndex: 'route',
      key: 'route',
      render: (route: string) => (
        <code style={{ background: 'var(--app-surface-muted)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>{route}</code>
      )
    },
    {
      title: '请求数',
      dataIndex: 'count',
      key: 'count',
      width: 110,
      align: 'right' as const,
      render: (count: number) => `${count} 次`
    },
    {
      title: '占比',
      key: 'progress',
      width: 160,
      render: (_: any, item: { count: number }) => (
        <Progress
          percent={Math.max(1, Math.round((item.count / routeTotalMax) * 100))}
          showInfo={false}
          size="small"
        />
      )
    }
  ];

  const providerColumns = [
    {
      title: "Provider",
      dataIndex: "provider",
      key: "provider",
      render: (provider: any) => (
        <Space>
          <ProviderIcon provider={provider} size={16} />
          {providerNames[provider as keyof typeof providerNames] || provider}
        </Space>
      )
    },
    {
      title: "健康 / 总数",
      key: "health",
      render: (_: any, record: ProviderRow) => `${record.active}/${record.total}`
    },
    {
      title: "队列",
      key: "queue",
      render: (_: any, record: ProviderRow) => formatQueueSnapshot(record.queue)
    },
    {
      title: "请求",
      key: "requests",
      render: (_: any, record: ProviderRow) => `${record.requests} / 成功 ${record.success} / 失败 ${record.failures}`
    },
    {
      title: "状态分布",
      key: "statuses",
      render: (_: any, record: ProviderRow) => (
        <Space wrap size={[6, 6]}>
          {Object.entries(record.statuses || {})
            .filter(([, count]) => Number(count) > 0)
            .map(([runtimeStatus, count]) => (
              <span key={runtimeStatus}>
                <RuntimeStatusTag status={runtimeStatus} /> {count}
              </span>
            ))}
        </Space>
      )
    }
  ];

  return (
    <PageScaffold ghost
      title="网关仪表盘"
      subTitle="展示本地 Server 调度、熔断、恢复和队列的真实运行态。"
      extra={[
        <Button key="clear" onClick={handleClearCooldown} loading={cooldownClearing}>
          清空冷却
        </Button>,
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          onClick={handleRefreshDashboard}
          loading={loading}
        >
          刷新
        </Button>
      ]}
    >
      {status?.cooldownAccounts ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`当前共有 ${status.cooldownAccounts} 个账号处于非健康态，已被调度层临时摘除。`}
        />
      ) : null}

      {/* 4 项关键指标 —— 用框架 StatisticCard.Group（自带卡片 + 响应式 + 分隔） */}
      <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard statistic={{ title: '总账号数', value: status?.totalAccounts || 0, prefix: <DashboardOutlined /> }} />
        <StatisticCard
          statistic={{
            title: '健康账号',
            value: status?.activeAccounts || 0,
            prefix: <CheckCircleOutlined />,
            valueStyle: { color: 'var(--color-success, #15803d)' }
          }}
        />
        <StatisticCard
          statistic={{
            title: '异常 / 冷却',
            value: degradedCount,
            prefix: <DisconnectOutlined />,
            valueStyle: { color: degradedCount > 0 ? 'var(--color-danger, #dc2626)' : undefined }
          }}
        />
        <StatisticCard
          statistic={{
            title: '成功率',
            value: formatPercent(status?.successRate),
            prefix: <SyncOutlined spin={loading} />
          }}
        />
      </StatisticCard.Group>

      <SectionCard title="服务运行参数">
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
          <Descriptions.Item label="Backend">{status?.backend || "-"}</Descriptions.Item>
          <Descriptions.Item label="调度策略">{status?.strategy || "-"}</Descriptions.Item>
          <Descriptions.Item label="监听地址">
            {status ? `${status.host}:${status.port}` : "-"}
          </Descriptions.Item>
          <Descriptions.Item label="Provider 模式">{status?.providerMode || "-"}</Descriptions.Item>
          <Descriptions.Item label="API Key">{status?.apiKeyConfigured ? "已配置" : "未配置"}</Descriptions.Item>
          <Descriptions.Item label="Sticky Session">{status?.sessionAffinity?.total || 0}</Descriptions.Item>
          <Descriptions.Item label="缓存模型">{status?.modelsCached || 0}</Descriptions.Item>
          <Descriptions.Item label="总请求">{status?.totalRequests || 0}</Descriptions.Item>
          <Descriptions.Item label="超时率">{formatPercent(status?.timeoutRate)}</Descriptions.Item>
          <Descriptions.Item label="运行时长">
            {typeof displayedUptimeSec === "number" ? `${displayedUptimeSec}s` : "-"}
          </Descriptions.Item>
        </Descriptions>
      </SectionCard>

      <SectionCard title="Provider 运行状态">
        <ListTable<ProviderRow>
          rowKey="provider"
          dataSource={providerRows}
          columns={providerColumns}
          loading={loading}
        />
      </SectionCard>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <SectionCard title="最近错误">
            <ListTable
              rowKey="__key"
              dataSource={recentErrorRows}
              columns={recentErrorColumns}
              loading={loading}
              scroll={{ x: 720 }}
            />
          </SectionCard>
        </Col>
        <Col xs={24} md={12}>
          <SectionCard title="热点路由">
            <ListTable
              rowKey="key"
              dataSource={routeRows}
              columns={routeColumns}
              loading={loading}
            />
          </SectionCard>
        </Col>
      </Row>
    </PageScaffold>
  );
}
