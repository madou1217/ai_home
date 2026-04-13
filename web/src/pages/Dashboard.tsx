import { useEffect, useMemo, useState } from 'react';
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
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag, { formatRuntimeUntil, getRuntimeStatusMeta } from '@/components/runtime/RuntimeStatusTag';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';

const { Text } = Typography;
const PROVIDERS: Provider[] = ['codex', 'gemini', 'claude'];

const formatPercent = (value?: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const getDashboardAccountPrimaryLabel = (record: Pick<ManagementAccount, 'email' | 'accountId' | 'provider' | 'id'>) => (
  record.email || record.accountId || `${record.provider || 'account'}-${record.id || ''}`
);
const getDashboardAccountTypeLabel = (record: Pick<ManagementAccount, 'planType' | 'apiKeyMode'>) => {
  if (record.planType) return record.planType;
  if (record.apiKeyMode) return 'api-key';
  return '';
};

const Dashboard = () => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [status, setStatus] = useState<ManagementStatus | null>(null);
  const [metrics, setMetrics] = useState<ManagementMetrics | null>(null);
  const [accounts, setAccounts] = useState<ManagementAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [cooldownClearing, setCooldownClearing] = useState(false);
  const [statusReceivedAt, setStatusReceivedAt] = useState(0);
  const [uptimeTickMs, setUptimeTickMs] = useState(() => Date.now());

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
      setStatus(nextStatus);
      setMetrics(nextMetrics);
      setAccounts(nextAccounts.accounts || []);
      setStatusReceivedAt(Date.now());
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
    loadDashboard({ showLoading: true });
  }, []);

  useEffect(() => {
    const watcher = managementAPI.watch({
      onSnapshot: ({ status: nextStatus, metrics: nextMetrics, accounts: nextAccounts }) => {
        setStatus(nextStatus);
        setMetrics(nextMetrics);
        setAccounts(nextAccounts || []);
        setStatusReceivedAt(Date.now());
        setLoading(false);
      },
      onError: () => {
        setLoading(false);
      }
    });
    return () => {
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
      await loadDashboard({ showLoading: true });
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '清空冷却失败');
    } finally {
      setCooldownClearing(false);
    }
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

  const accountRows = useMemo(() => {
    return [...accounts].sort((left, right) => {
      if (left.runtimeStatus === right.runtimeStatus) {
        return Number(right.runtimeUntil || 0) - Number(left.runtimeUntil || 0);
      }
      if (left.runtimeStatus === 'healthy') return 1;
      if (right.runtimeStatus === 'healthy') return -1;
      return String(left.runtimeStatus || '').localeCompare(String(right.runtimeStatus || ''));
    });
  }, [accounts]);

  const degradedCount = Math.max(0, Number(status?.totalAccounts || 0) - Number(status?.activeAccounts || 0));
  const recentErrors = metrics?.lastErrors || [];

  if (isMobile) {
    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>统计</h1>
            <Text type="secondary">手机版只保留最核心的账号数量。</Text>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => loadDashboard({ showLoading: true })}
            loading={loading}
          >
            刷新
          </Button>
        </div>

        <Card loading={loading} style={{ borderRadius: 18 }}>
          <Statistic
            title="可用账号总数"
            value={status?.activeAccounts || 0}
            prefix={<DashboardOutlined />}
            valueStyle={{ color: '#1677ff', fontSize: 36 }}
          />
          <Space wrap size={[8, 8]} style={{ marginTop: 14 }}>
            {PROVIDERS.map((provider) => (
              <Tag key={provider} color="blue">
                <Space size={4}>
                  <ProviderIcon provider={provider} size={12} />
                  {providerNames[provider]}
                  <span>{status?.providers?.[provider]?.active || 0}</span>
                </Space>
              </Tag>
            ))}
          </Space>
          {degradedCount > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16 }}
              message={`当前还有 ${degradedCount} 个账号处于异常或冷却状态`}
            />
          ) : null}
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0 }}>仪表盘</h1>
          <Text type="secondary">这里展示 server 调度、熔断、恢复和队列的真实运行态。</Text>
        </div>
        <Space>
          <Button onClick={handleClearCooldown} loading={cooldownClearing}>
            清空冷却
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => loadDashboard({ showLoading: true })}
            loading={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

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
        <Col xs={24} xl={14}>
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
        <Col xs={24} xl={10}>
          <Card loading={loading} title="运行状态分布">
            {status?.statusTotals && Object.keys(status.statusTotals).length > 0 ? (
              <Space wrap size={[8, 10]}>
                {Object.entries(status.statusTotals)
                  .filter(([, count]) => Number(count) > 0)
                  .sort((left, right) => Number(right[1]) - Number(left[1]))
                  .map(([runtimeStatus, count]) => {
                    const meta = getRuntimeStatusMeta(runtimeStatus);
                    return (
                      <div
                        key={runtimeStatus}
                        style={{
                          minWidth: 120,
                          border: '1px solid #f0f0f0',
                          borderRadius: 12,
                          padding: '10px 12px',
                          background: '#fafafa'
                        }}
                      >
                        <div style={{ marginBottom: 6 }}>
                          <RuntimeStatusTag status={runtimeStatus} fallback={meta.label} />
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 600 }}>{count}</div>
                      </div>
                    );
                  })}
              </Space>
            ) : (
              <Empty description="暂无运行状态数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
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
                const snapshot = record.queue;
                return snapshot
                  ? `${snapshot.running} 运行 / ${snapshot.queued} 排队 / 并发 ${snapshot.maxConcurrency}`
                  : '-';
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
                      <div style={{ marginBottom: 4 }}>
                        <RuntimeStatusTag status="upstream_error" fallback={item.provider || 'unknown'} />
                        <Text type="secondary" style={{ marginLeft: 8 }}>
                          {item.at || '-'}
                        </Text>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {item.message || '-'}
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

      <Card loading={loading} title="账号运行态明细">
        <Table
          rowKey={(record) => `${record.provider}-${record.id}`}
          dataSource={accountRows}
          pagination={{ pageSize: 12, showSizeChanger: true }}
          scroll={{ x: 1200 }}
          columns={[
            {
              title: '账号',
              key: 'account',
              render: (_, record) => (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                    <ProviderIcon provider={record.provider} size={14} />
                    {getDashboardAccountPrimaryLabel(record)}
                  </div>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {getDashboardAccountTypeLabel(record) || '-'}
                  </div>
                </div>
              )
            },
            {
              title: '运行状态',
              dataIndex: 'runtimeStatus',
              key: 'runtimeStatus',
              render: (runtimeStatus: string, record: ManagementAccount) => (
                <RuntimeStatusTag
                  status={runtimeStatus}
                  reason={record.runtimeReason}
                  until={record.runtimeUntil}
                />
              )
            },
            {
              title: '恢复时间',
              dataIndex: 'runtimeUntil',
              key: 'runtimeUntil',
              render: (value: number) => formatRuntimeUntil(value)
            },
            {
              title: '剩余额度',
              dataIndex: 'remainingPct',
              key: 'remainingPct',
              width: 260,
              render: (_remainingPct: number | null, record: ManagementAccount) => (
                <UsageSnapshotCell record={record} />
              )
            },
            {
              title: '成功 / 失败',
              key: 'counts',
              render: (_, record) => `${record.successCount || 0} / ${record.failCount || 0}`
            },
            {
              title: '最近原因',
              key: 'reason',
              render: (_, record) => (
                <Text ellipsis={{ tooltip: record.runtimeReason || record.lastError || '-' }} style={{ maxWidth: 320 }}>
                  {record.runtimeReason || record.lastError || '-'}
                </Text>
              )
            }
          ]}
        />
      </Card>
    </div>
  );
};

export default Dashboard;
