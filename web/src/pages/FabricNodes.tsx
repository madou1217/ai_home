import { StatisticCard } from '@ant-design/pro-components';
import './FabricNodes.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Col, List, Row, Space, Tag, Typography, message, Descriptions } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';
import {
  ApartmentOutlined,
  CloudServerOutlined,
  ReloadOutlined,
  ClusterOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  buildFabricRegistryRelayViews,
  readActiveFabricRegistry
} from '@/services/fabric-registry';
import type {
  FabricNodeAction,
  FabricNodeInventoryItem,
  FabricRegistryNode,
  FabricRegistryRelayView,
  FabricRegistryResult,
  FabricRegistryTransport
} from '@/services/fabric-registry';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  syncSharedControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  addActiveControlPlaneProfileChangeListener,
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import type { ControlPlaneProfile } from '@/types';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';

const STATUS_COLORS: Record<string, string> = {
  available: 'green',
  disabled: 'default',
  degraded: 'orange',
  down: 'red',
  failed: 'red',
  healthy: 'green',
  offline: 'red',
  online: 'green',
  partial: 'gold',
  pending: 'gold',
  ready: 'green',
  unknown: 'default',
  up: 'green'
};

function normalizeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '加载失败');
}

function normalizeText(value: unknown, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function getStatusColor(status: unknown) {
  return STATUS_COLORS[String(status || '').toLowerCase()] || 'default';
}

function formatTime(value: unknown) {
  const timestamp = Number(value || 0);
  if (!timestamp) return 'never';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'invalid';
  return date.toLocaleString();
}

function formatMeasuredAt(value: unknown) {
  const timestamp = Number(value || 0);
  if (!timestamp) return 'not measured';
  return formatTime(timestamp);
}

function formatBandwidthKbps(value: unknown) {
  const bandwidth = Number(value || 0);
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return 'unlimited';
  if (bandwidth >= 1000) return `${Math.round(bandwidth / 100) / 10} Mbps`;
  return `${Math.floor(bandwidth)} Kbps`;
}

function formatPlatform(node: FabricRegistryNode) {
  return [node.platform, node.arch].map((item) => String(item || '').trim()).filter(Boolean).join(' / ') || 'unknown';
}

function getTransportHealth(transport: FabricRegistryTransport) {
  return normalizeText(transport.health);
}

function formatTransportMeasurement(transport: FabricRegistryTransport) {
  const measurement = transport.measurement;
  if (!measurement) return 'no measurement';
  const parts = [];
  if (measurement.rttMs && measurement.rttMs.count) parts.push(`p95 ${measurement.rttMs.p95}ms`);
  if (measurement.sampleCount && measurement.successRate !== null) {
    parts.push(`${Math.round(measurement.successRate * 100)}% ok (${measurement.sampleCount})`);
  } else if (measurement.successes || measurement.failures) {
    parts.push(`${measurement.successes}/${measurement.successes + measurement.failures} ok`);
  }
  if (measurement.durationMs) parts.push(`${measurement.durationMs}ms`);
  if (measurement.status) parts.push(measurement.status);
  if (measurement.failureReason) parts.push(measurement.failureReason);
  return parts.join(' · ') || 'measured';
}

function summarizeRelayMeasurement(transports: FabricRegistryTransport[]) {
  const measured = transports.find((transport) => transport.measurement);
  return measured ? formatTransportMeasurement(measured) : 'no measurement';
}



function formatBlocker(value: string) {
  const [code, provider, status] = String(value || '').split(':');
  const labels: Record<string, string> = {
    m4_project_action_pending: '项目打开动作待 M4 接入',
    m4_remote_session_action_pending: '远程会话动作待 M4 接入',
    missing_project_snapshot: '缺少项目快照',
    missing_transport: '缺少传输通道',
    missing_ssh_bootstrap_transport: '未配置 SSH bootstrap',
    relay_already_registered: '已是 relay node',
    relay_role_enable_flow_pending: '启用 relay 流程待接入'
  };
  if (code === 'missing_provider_runtime') return `缺少 ${provider || 'provider'} runtime`;
  if (code === 'provider_runtime_not_ready') return `${provider || 'provider'} runtime 不可用${status ? ` (${status})` : ''}`;
  return labels[code] || value;
}

function ActionSummary({ actions }: { actions: FabricNodeAction[] }) {
  const visible = actions.filter((action) => action.id.startsWith('start-session:') || action.id === 'open-project');
  if (visible.length === 0) return <Tag>no actions</Tag>;
  return (
    <Space size={[4, 4]} wrap>
      {visible.map((action) => (
        <Tag key={action.id} color={action.eligible ? 'blue' : 'default'}>
          {action.label}: {action.eligible ? 'eligible' : formatBlocker(action.blockers[0] || 'blocked')}
        </Tag>
      ))}
    </Space>
  );
}

function getInitialProfile() {
  const profiles = listControlPlaneProfiles();
  const active = resolveStoredActiveControlPlaneProfile(profiles, getActiveControlPlaneProfileId());
  return active.profile || null;
}

function StatusTag({ status }: { status: unknown }) {
  const label = normalizeText(status);
  return <Tag color={getStatusColor(label)}>{label}</Tag>;
}

function TagList({ items, emptyLabel }: { items?: string[]; emptyLabel: string }) {
  const values = (items || []).filter(Boolean);
  if (values.length === 0) return <Tag>{emptyLabel}</Tag>;
  return (
    <>
      {values.map((item) => (
        <Tag key={item}>{item}</Tag>
      ))}
    </>
  );
}

const RELAY_COLUMNS: ProColumns<FabricRegistryRelayView>[] = [
  {
    title: 'Relay',
    dataIndex: 'relayNode',
    width: 180,
    render: (_, record) => {
      const { relayNode, node } = record;
      return (
        <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node?.name || relayNode.nodeId}
          </strong>
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{relayNode.id}</span>
        </Space>
      );
    }
  },
  {
    title: 'capacityClass',
    dataIndex: 'relayNode',
    width: 110,
    render: (_, record) => record.relayNode.capacityClass || 'tiny'
  },
  {
    title: 'bandwidth',
    dataIndex: 'relayNode',
    width: 120,
    render: (_, record) => formatBandwidthKbps(record.relayNode.bandwidthLimitKbps)
  },
  {
    title: 'status',
    dataIndex: 'relayNode',
    width: 100,
    render: (_, record) => record.relayNode.status || (record.relayNode.enabled ? 'online' : 'disabled')
  },
  {
    title: 'health',
    dataIndex: 'health',
    width: 100,
    render: (_, record) => record.health
  },
  {
    title: 'measurement',
    dataIndex: 'transports',
    render: (_, record) => summarizeRelayMeasurement(record.transports)
  },
  {
    title: 'measured',
    dataIndex: 'transports',
    width: 180,
    render: (_, record) => formatMeasuredAt(
      record.transports.find((transport) => transport.measurement)?.measurement?.measuredAt || record.relayNode.lastMeasuredAt
    )
  },
  {
    title: 'transports',
    dataIndex: 'transports',
    render: (_, record) => {
      const transports = record.transports;
      if (transports.length === 0) return <Tag>transport none</Tag>;
      return (
        <Space size={[4, 4]} wrap>
          {transports.map((transport) => (
            <Tag key={transport.id} color={getStatusColor(getTransportHealth(transport))}>
              {transport.kind || transport.id}: {getTransportHealth(transport)}
            </Tag>
          ))}
        </Space>
      );
    }
  }
];

function NodeDetailList<T>({ header, items, empty, getKey, render }: {
  header: string;
  items: T[];
  empty: string;
  getKey: (item: T) => string;
  render: (item: T) => { title: ReactNode; description: ReactNode };
}) {
  return (
    <List
      size="small"
      header={<Typography.Text strong>{header}</Typography.Text>}
      dataSource={items}
      locale={{ emptyText: empty }}
      renderItem={(item) => {
        const { title, description } = render(item);
        return (
          <List.Item key={getKey(item)}>
            <List.Item.Meta title={title} description={description} />
          </List.Item>
        );
      }}
    />
  );
}

function nodeCapabilityTags(view: FabricNodeInventoryItem) {
  return [
    ...(view.capabilities.node ? ['node'] : []),
    ...(view.capabilities.relayNode ? ['relay-node'] : []),
    ...(view.capabilities.runtimeHost ? ['runtime-host'] : []),
    ...(view.capabilities.sshBootstrap ? ['ssh-bootstrap'] : [])
  ];
}

const NODE_COLUMNS: ProColumns<FabricNodeInventoryItem>[] = [
  {
    title: '节点',
    dataIndex: ['node', 'name'],
    render: (_, { node }) => (
      <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name || node.id}
        </strong>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{node.id}</Typography.Text>
      </Space>
    )
  },
  {
    title: '能力',
    dataIndex: 'capabilities',
    width: 200,
    render: (_, view) => (
      <Space size={[4, 4]} wrap>
        <TagList items={nodeCapabilityTags(view)} emptyLabel="node" />
      </Space>
    )
  },
  {
    title: '状态',
    dataIndex: ['node', 'status'],
    width: 150,
    render: (_, { node }) => (
      <Space direction="vertical" size={2} style={{ minWidth: 0 }}>
        <StatusTag status={node.status || 'unknown'} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatPlatform(node)}</Typography.Text>
      </Space>
    )
  },
  {
    title: '资源',
    dataIndex: 'projects',
    width: 130,
    render: (_, view) => (
      <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{view.projects.length} projects</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{view.runtimes.length} runtimes</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{view.capabilities.transportState}</Typography.Text>
      </Space>
    )
  },
  {
    title: 'lastSeen',
    dataIndex: ['node', 'lastSeenAt'],
    width: 170,
    render: (_, view) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTime(view.node.lastSeenAt)}</Typography.Text>
    )
  }
];

export default function FabricNodes() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<ControlPlaneProfile | null>(getInitialProfile);
  const [registry, setRegistry] = useState<FabricRegistryResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const nodeViews = useMemo<FabricNodeInventoryItem[]>(
    () => registry ? registry.nodeInventory : [],
    [registry]
  );
  const relayViews = useMemo(
    () => registry ? buildFabricRegistryRelayViews(registry) : [],
    [registry]
  );
  const counts = registry?.counts || {
    nodes: 0,
    relayNodes: 0,
    projects: 0,
    runtimes: 0,
    transports: 0
  };
  const selectedNode = nodeViews.find((view) => view.node.id === selectedNodeId) || nodeViews[0] || null;
  const readyProfile = activeProfile && isControlPlaneProfileReady(activeProfile) ? activeProfile : null;
  const readyProfileKey = readyProfile
    ? `${readyProfile.id}:${readyProfile.updatedAt}:${readyProfile.deviceToken ? 'token' : 'missing-token'}`
    : '';

  const refreshProfile = useCallback(() => {
    setActiveProfile(getInitialProfile());
  }, []);

  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await readActiveFabricRegistry();
      setActiveProfile(result.profile);
      setRegistry(result || null);
      const nextViews = result.nodeInventory;
      setSelectedNodeId((current) => (
        current && nextViews.some((view) => view.node.id === current)
          ? current
          : nextViews[0]?.node.id || ''
      ));
    } catch (loadError) {
      const messageText = normalizeError(loadError);
      setError(messageText);
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    syncSharedControlPlaneProfiles()
      .catch(() => null)
      .finally(() => {
        if (!cancelled) refreshProfile();
      });
    refreshProfile();
    const unsubscribeProfiles = addControlPlaneProfilesChangeListener(refreshProfile);
    const unsubscribeActive = addActiveControlPlaneProfileChangeListener(refreshProfile);
    window.addEventListener('focus', refreshProfile);
    return () => {
      cancelled = true;
      unsubscribeProfiles();
      unsubscribeActive();
      window.removeEventListener('focus', refreshProfile);
    };
  }, [refreshProfile]);

  useEffect(() => {
    if (!readyProfileKey) {
      setRegistry(null);
      setSelectedNodeId('');
      setError('');
      return;
    }
    loadRegistry();
  }, [loadRegistry, readyProfileKey]);



  return (
    <PageScaffold ghost
      title="节点总览 (Nodes)"
      subTitle="所有能连上的机器统一显示为 Node；SSH、relay、provider runtime 和健康度都是 Node 的能力或观测结果。"
      extra={
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={() => readyProfile && loadRegistry()}
          loading={loading}
          disabled={!readyProfile}
        >
          刷新状态
        </Button>
      }
    >
      {!readyProfile && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未绑定有效的 Server Profile"
          description="Fabric 监控需要从已授权的 Server Profile 读取 Registry 数据。请先完成配对设置。"
          action={(
            <Button size="small" onClick={() => navigate("/server-setup")}>
              去配置
            </Button>
          )}
        />
      )}

      {error && readyProfile && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="Registry 拓扑数据获取失败"
          description={error}
        />
      )}

      {readyProfile && (
        <>
          {/* 控制面状态 */}
          <SectionCard title="控制面状态">
            <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
              <Descriptions.Item label="服务地址">{readyProfile.endpoint}</Descriptions.Item>
              <Descriptions.Item label="连接状态">
                <Space>
                  <StatusTag status={readyProfile.state} />
                  <StatusTag status={readyProfile.authState} />
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="检测时间">{formatTime(readyProfile.lastCheckedAt || readyProfile.updatedAt)}</Descriptions.Item>
            </Descriptions>
          </SectionCard>

          {/* 关键运营指标：节点 / 中继 / 运行会话。项目数、传输通道数已在节点表内逐行展示，剔除。 */}
          <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
            <StatisticCard statistic={{ title: '计算节点数', value: loading ? '-' : counts.nodes, prefix: <ClusterOutlined /> }} />
            <StatisticCard statistic={{ title: '中继中枢', value: loading ? '-' : counts.relayNodes, prefix: <CloudServerOutlined /> }} />
            <StatisticCard statistic={{ title: '运行会话', value: loading ? '-' : counts.runtimes, prefix: <ToolOutlined /> }} />
          </StatisticCard.Group>
          <SectionCard title="计算节点列表" extra={<ApartmentOutlined />} bodyStyle={{ padding: 0 }}>
            <ListTable<FabricNodeInventoryItem>
              columns={NODE_COLUMNS}
              dataSource={nodeViews}
              rowKey={(row) => row.node.id}
              loading={loading && !registry}
              onRow={(record) => ({
                onClick: () => setSelectedNodeId(record.node.id),
                style: { cursor: 'pointer' }
              })}
              rowClassName={(record) => (
                record.node.id === selectedNode?.node.id ? 'fabric-node-row-selected' : ''
              )}
            />
          </SectionCard>

          {selectedNode && (counts.nodes > 0) && (
            <SectionCard
              title={selectedNode?.node.name || selectedNode?.node.id || "节点属性详情"}
              extra={selectedNode ? <StatusTag status={selectedNode.node.status || "unknown"} /> : null}
            >
              {/* 主从两栏：左＝身份/能力/中继元数据，右＝项目/运行时/传输清单；不再纵向平铺。
                  Action Gating 与 actions 行重复，已剔除。 */}
              <Row gutter={[24, 16]}>
                <Col xs={24} lg={10}>
                  <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                    <Descriptions
                      column={1}
                      size="small"
                      colon={false}
                      labelStyle={{ width: 105, color: 'var(--app-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                    >
                      <Descriptions.Item label="roles">
                        <TagList items={selectedNode.node.roles} emptyLabel="node" />
                      </Descriptions.Item>
                      <Descriptions.Item label="platform">
                        <strong>{formatPlatform(selectedNode.node)}</strong>
                      </Descriptions.Item>
                      <Descriptions.Item label="capabilities">
                        <TagList
                          items={[
                            ...(selectedNode.capabilities.server ? ['server'] : []),
                            ...(selectedNode.capabilities.node ? ['node'] : []),
                            ...(selectedNode.capabilities.relayNode ? [`relay:${selectedNode.capabilities.relayState}`] : []),
                            ...(selectedNode.capabilities.projectHost ? ['project-host'] : []),
                            ...(selectedNode.capabilities.runtimeHost ? ['runtime-host'] : []),
                            ...(selectedNode.capabilities.sshBootstrap ? ['ssh-bootstrap'] : []),
                            ...(selectedNode.capabilities.measured ? ['measured'] : [])
                          ]}
                          emptyLabel="none"
                        />
                      </Descriptions.Item>
                      <Descriptions.Item label="actions">
                        <ActionSummary actions={selectedNode.actions} />
                      </Descriptions.Item>
                    </Descriptions>

                    {selectedNode.relayNode ? (
                      <Descriptions
                        title={<Typography.Text strong>Relay Metadata</Typography.Text>}
                        size="small"
                        column={1}
                        bordered
                      >
                        <Descriptions.Item label="capacityClass">{selectedNode.relayNode.capacityClass || 'tiny'}</Descriptions.Item>
                        <Descriptions.Item label="bandwidth">{formatBandwidthKbps(selectedNode.relayNode.bandwidthLimitKbps)}</Descriptions.Item>
                        <Descriptions.Item label="status">{selectedNode.relayNode.status || 'unknown'}</Descriptions.Item>
                        <Descriptions.Item label="measurement">{summarizeRelayMeasurement(selectedNode.transports)}</Descriptions.Item>
                        <Descriptions.Item label="measured">{formatMeasuredAt(selectedNode.transports.find((transport) => transport.measurement)?.measurement?.measuredAt || selectedNode.relayNode.lastMeasuredAt)}</Descriptions.Item>
                      </Descriptions>
                    ) : (
                      <div>
                        <Typography.Text strong>Relay Metadata</Typography.Text>
                        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                          该 node 未声明 relay-node metadata。
                        </Typography.Paragraph>
                      </div>
                    )}
                  </Space>
                </Col>

                <Col xs={24} lg={14}>
                  <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                    <NodeDetailList
                      header="Projects"
                      items={selectedNode.projects}
                      empty="暂无 project snapshot。"
                      getKey={(project) => project.id}
                      render={(project) => ({
                        title: project.name || project.id,
                        description: (
                          <Space direction="vertical" size={0}>
                            <span>{project.displayPath || project.vcs || project.id}</span>
                            <span>{project.permissions?.join(', ') || 'permissions unknown'}</span>
                          </Space>
                        )
                      })}
                    />

                    <NodeDetailList
                      header="Runtimes"
                      items={selectedNode.runtimes}
                      empty="暂无 provider runtime snapshot；该 node 目前不能作为 Codex / Claude / AGY / OpenCode runtime host。"
                      getKey={(runtime) => runtime.id}
                      render={(runtime) => ({
                        title: `${normalizeText(runtime.provider)} / ${normalizeText(runtime.mode, 'tui')}`,
                        description: (
                          <Space direction="vertical" size={0}>
                            <span>{runtime.version || 'version unknown'}</span>
                            <span>{runtime.status || 'available'}</span>
                          </Space>
                        )
                      })}
                    />

                    <NodeDetailList
                      header="Transports"
                      items={selectedNode.transports}
                      empty="暂无 transport snapshot。"
                      getKey={(transport) => transport.id}
                      render={(transport) => ({
                        title: transport.kind || transport.id,
                        description: (
                          <Space direction="vertical" size={0}>
                            <span>{transport.endpoint || transport.provider || 'endpoint hidden'}</span>
                            <span>{getTransportHealth(transport)} · {formatTransportMeasurement(transport)}{transport.lastError ? ` · ${transport.lastError}` : ''}</span>
                          </Space>
                        )
                      })}
                    />
                  </Space>
                </Col>
              </Row>
            </SectionCard>
          )}

          <SectionCard
            title="中继中枢健康度 (Relay Health)"
            extra={<CloudServerOutlined />}
          >
            <ListTable
              columns={RELAY_COLUMNS}
              dataSource={relayViews}
              rowKey={(row) => row.relayNode.id}
              loading={loading}
            />
          </SectionCard>
        </>
      )}
    </PageScaffold>
  );
}
