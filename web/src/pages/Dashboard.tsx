import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  List,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Typography,
  message,
  Tag,
  Grid
} from 'antd';
import {
  CheckCircleOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  ReloadOutlined,
  SyncOutlined
} from '@ant-design/icons';
import { managementAPI } from '@/services/api';
import type { ManagementAccount, ManagementMetrics, ManagementStatus, Provider } from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import PageHero from '@/components/ui/PageHero';
import './Dashboard.css';

const { Text } = Typography;
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
  const message = String(item?.message || item?.error || item?.detail || item?.reason || '').trim();
  if (message) return message;
  return '未提供错误详情';
}

function getRecentErrorProvider(item: ManagementMetrics['lastErrors'][number]) {
  const provider = String(item.provider || '').trim().toLowerCase();
  return PROVIDERS.includes(provider as Provider) ? provider as Provider : null;
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

const Dashboard = () => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
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

  const loadDashboard = async (options: { showLoading?: boolean; quietError?: boolean } = {}) => {
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
  };

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
  }, []);

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

  const providerRows = useMemo(() => {
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
  const liveTag = liveState === 'live'
    ? { color: 'green', text: '实时' }
    : liveState === 'connecting'
      ? { color: 'blue', text: '连接中' }
      : { color: 'orange', text: '降级' };
  const recentErrors = metrics?.lastErrors || [];
  const accountByRef = useMemo(() => {
    return new Map(
      accounts
        .filter((account) => account.accountRef)
        .map((account) => [String(account.accountRef || ''), account])
    );
  }, [accounts]);

  if (isMobile) {
    return (
      <div className="dashboard-page">
        <PageHero
          title="仪表盘"
          eyebrow="运行态"
          description="这里展示 server 调度、熔断、恢复和队列的真实运行态。"
          actions={(
            <Space>
              <Tag color={liveTag.color}>{liveTag.text}</Tag>
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                onClick={handleRefreshDashboard}
                loading={loading}
              >
                刷新
              </Button>
            </Space>
          )}
        />

        {degradedCount > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`${degradedCount} 个账号处于异常或冷却状态`}
          />
        ) : null}

        {/* 4 项关键指标 2×2 */}
        <Row gutter={[10, 10]}>
          <Col span={12}>
            <Card loading={loading} size="small">
              <Statistic
                title="总账号数"
                value={status?.totalAccounts || 0}
                prefix={<DashboardOutlined />}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card loading={loading} size="small">
              <Statistic
                title="健康账号"
                value={status?.activeAccounts || 0}
                prefix={<CheckCircleOutlined />}
                valueStyle={{ color: '#15803d' }}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card loading={loading} size="small">
              <Statistic
                title="异常 / 冷却"
                value={degradedCount}
                prefix={<DisconnectOutlined />}
                valueStyle={{ color: degradedCount > 0 ? '#dc2626' : undefined }}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card loading={loading} size="small">
              <Statistic
                title="成功率"
                value={formatPercent(status?.successRate)}
                prefix={<SyncOutlined spin={loading} />}
              />
            </Card>
          </Col>
        </Row>

        {/* Provider 健康状态 */}
        <Card loading={loading} title="Provider 状态" size="small">
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            {PROVIDERS.map((provider) => {
              const pdata = status?.providers?.[provider];
              const active = pdata?.active || 0;
              const total = pdata?.total || 0;
              return (
                <div key={provider} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Space size={6}>
                    <ProviderIcon provider={provider} size={15} />
                    <Text strong>{providerNames[provider]}</Text>
                  </Space>
                  <Space size={6}>
                    <Text type="secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                      {active}/{total}
                    </Text>
                    <Tag color={active > 0 ? 'green' : 'default'} style={{ margin: 0 }}>
                      {active > 0 ? '正常' : '无可用'}
                    </Tag>
                  </Space>
                </div>
              );
            })}
          </Space>
        </Card>

        {/* 服务关键参数 */}
        <Card loading={loading} title="服务信息" size="small">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Backend">{status?.backend || '-'}</Descriptions.Item>
            <Descriptions.Item label="调度策略">{status?.strategy || '-'}</Descriptions.Item>
            <Descriptions.Item label="监听地址">{status ? `${status.host}:${status.port}` : '-'}</Descriptions.Item>
            <Descriptions.Item label="总请求">{status?.totalRequests || 0}</Descriptions.Item>
            <Descriptions.Item label="运行时长">{typeof displayedUptimeSec === 'number' ? `${displayedUptimeSec}s` : '-'}</Descriptions.Item>
          </Descriptions>
        </Card>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <PageHero
        title="仪表盘"
        eyebrow="运行态"
        description="这里展示 server 调度、熔断、恢复和队列的真实运行态。"
        actions={(
          <Space>
            <Button onClick={handleClearCooldown} loading={cooldownClearing}>
              清空冷却
            </Button>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={handleRefreshDashboard}
              loading={loading}
            >
              刷新
            </Button>
            <Tag color={liveTag.color}>{liveTag.text}</Tag>
          </Space>
        )}
      />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12} xl={6}>
          <Card loading={loading}>
            <Statistic title="总账号数" value={status?.totalAccounts || 0} prefix={<DashboardOutlined />} />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card loading={loading}>
            <Statistic
              title="健康账号"
              value={status?.activeAccounts || 0}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card loading={loading}>
            <Statistic
              title="异常 / 冷却"
              value={degradedCount}
              prefix={<DisconnectOutlined />}
              valueStyle={{ color: degradedCount > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card loading={loading}>
            <Statistic
              title="成功率"
              value={formatPercent(status?.successRate)}
              prefix={<SyncOutlined spin={loading} />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={24}>
          <Card loading={loading} title="服务运行态">
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="Backend">{status?.backend || '-'}</Descriptions.Item>
              <Descriptions.Item label="调度策略">{status?.strategy || '-'}</Descriptions.Item>
              <Descriptions.Item label="监听地址">
                {status ? `${status.host}:${status.port}` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Provider 模式">{status?.providerMode || '-'}</Descriptions.Item>
              <Descriptions.Item label="API Key">{status?.apiKeyConfigured ? '已配置' : '未配置'}</Descriptions.Item>
              <Descriptions.Item label="Sticky Session">{status?.sessionAffinity?.total || 0}</Descriptions.Item>
              <Descriptions.Item label="缓存模型">{status?.modelsCached || 0}</Descriptions.Item>
              <Descriptions.Item label="总请求">{status?.totalRequests || 0}</Descriptions.Item>
              <Descriptions.Item label="超时率">{formatPercent(status?.timeoutRate)}</Descriptions.Item>
              <Descriptions.Item label="运行时长">
                {typeof displayedUptimeSec === 'number' ? `${displayedUptimeSec}s` : '-'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Card loading={loading} title="Provider 运行态" style={{ marginBottom: 16 }}>
        <Table
          rowKey="provider"
          pagination={false}
          dataSource={providerRows}
          columns={[
            {
              title: 'Provider',
              dataIndex: 'provider',
              key: 'provider',
              render: (provider: Provider) => (
                <Space>
                  <ProviderIcon provider={provider} size={16} />
                  {providerNames[provider]}
                </Space>
              )
            },
            {
              title: '健康 / 总数',
              key: 'health',
              render: (_, record) => `${record.active}/${record.total}`
            },
            {
              title: '队列',
              key: 'queue',
              render: (_, record) => {
                return formatQueueSnapshot(record.queue);
              }
            },
            {
              title: '请求',
              key: 'requests',
              render: (_, record) => `${record.requests} / 成功 ${record.success} / 失败 ${record.failures}`
            },
            {
              title: '状态分布',
              key: 'statuses',
              render: (_, record) => (
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
          ]}
        />
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={12}>
          <Card loading={loading} title="最近错误">
            {recentErrors.length === 0 ? (
              <Empty description="最近没有错误" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <List
                dataSource={recentErrors.slice(0, 8)}
                renderItem={(item) => (
                  <List.Item>
                    <div style={{ width: '100%' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 6
                        }}
                      >
                        <Space size={8} wrap>
                          {(() => {
                            const provider = getRecentErrorProvider(item);
                            const accountRef = getRecentErrorAccountRef(item);
                            const account = accountRef ? accountByRef.get(accountRef) : undefined;
                            const accountId = account ? String(account.accountId || account.id || '').trim() : '';
                            if (!provider) {
                              return <RuntimeStatusTag status="upstream_error" fallback="unknown" />;
                            }
                            return (
                              <>
                                <Space size={5}>
                                  <ProviderIcon provider={provider} size={15} />
                                  <Text strong>{providerNames[provider]}</Text>
                                </Space>
                                {accountId ? (
                                  <a href={buildAccountLink(provider, accountId)}>
                                    {getManagementAccountLabel(account) || '查看对应账号'}
                                  </a>
                                ) : null}
                              </>
                            );
                          })()}
                        </Space>
                        <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
                          {formatRecentErrorTime(item.at)}
                        </Text>
                      </div>
                      {item.route ? (
                        <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                          {item.route}
                        </Text>
                      ) : null}
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {formatRecentErrorMessage(item)}
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card loading={loading} title="热点路由">
            {routeRows.length === 0 ? (
              <Empty description="暂无路由统计" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <List
                dataSource={routeRows}
                renderItem={(item) => (
                  <List.Item>
                    <div style={{ width: '100%' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <Text code>{item.route}</Text>
                        <Text>{item.count}</Text>
                      </div>
                      <Progress
                        percent={Math.max(1, Math.round((item.count / Math.max(routeRows[0].count, 1)) * 100))}
                        showInfo={false}
                        size="small"
                      />
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

      {status?.cooldownAccounts ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`当前共有 ${status.cooldownAccounts} 个账号处于非健康态，已被调度层临时摘除。`}
        />
      ) : null}

    </div>
  );
};

export default Dashboard;
