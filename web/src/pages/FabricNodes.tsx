import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Skeleton, Space, Tag, message, Descriptions } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';
import {
  ApartmentOutlined,
  CloudServerOutlined,
  ReloadOutlined
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
  FabricRegistryRelayNode,
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



function resolveRelayScore(relay: FabricRegistryRelayNode) {
  if (relay.lastMeasuredAt) return 'measured / no score';
  return 'no measurement';
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
    title: 'score',
    dataIndex: 'relayNode',
    width: 150,
    render: (_, record) => resolveRelayScore(record.relayNode)
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

  const headerContent = readyProfile && (
    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginTop: 8 }}>
      <Descriptions.Item label="当前服务">{readyProfile.name}</Descriptions.Item>
      <Descriptions.Item label="服务地址">{readyProfile.endpoint}</Descriptions.Item>
      <Descriptions.Item label="连接状态">
        <Space>
          <StatusTag status={readyProfile.state} />
          <StatusTag status={readyProfile.authState} />
        </Space>
      </Descriptions.Item>
      <Descriptions.Item label="最近检测时间">{formatTime(readyProfile.lastCheckedAt || readyProfile.updatedAt)}</Descriptions.Item>
      <Descriptions.Item label="拓扑计数">
        <Space size={4} wrap>
          <Tag color="blue">节点 {loading ? '-' : counts.nodes}</Tag>
          <Tag color="blue">中继 {loading ? '-' : counts.relayNodes}</Tag>
          <Tag color="blue">项目 {loading ? '-' : counts.projects}</Tag>
          <Tag color="blue">Runtime {loading ? '-' : counts.runtimes}</Tag>
          <Tag color="blue">通道 {loading ? '-' : counts.transports}</Tag>
        </Space>
      </Descriptions.Item>
    </Descriptions>
  );

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
      headerContent={headerContent}
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
          {loading && !registry ? (
            <SectionCard>
              <Skeleton active paragraph={{ rows: 8 }} />
            </SectionCard>
          ) : counts.nodes === 0 ? (
            <SectionCard title="计算节点列表" extra={<ApartmentOutlined />}>
              <p style={{ margin: 0, color: 'rgba(0,0,0,0.45)' }}>暂无数据：拓扑中暂无可用计算节点。等待 Node 节点执行加入发布以同步状态。</p>
            </SectionCard>
          ) : (
            <SectionCard title="计算节点列表" extra={<ApartmentOutlined />} bodyStyle={{ padding: 0 }}>
              <div className="fabric-nodes-list">
                {nodeViews.map((view) => {
                  const active = selectedNode?.node.id === view.node.id;
                  return (
                    <button
                      key={view.node.id}
                      type="button"
                      className={`fabric-node-row${active ? " fabric-node-row--active" : ""}`}
                      onClick={() => setSelectedNodeId(view.node.id)}
                      title={view.node.name || view.node.id}
                    >
                      <div className="fabric-node-row-main">
                        <strong>{view.node.name || view.node.id}</strong>
                        <span>{view.node.id}</span>
                      </div>
                      <div className="fabric-node-row-tags">
                        <TagList
                          items={[
                            ...(view.capabilities.node ? ['node'] : []),
                            ...(view.capabilities.relayNode ? ['relay-node'] : []),
                            ...(view.capabilities.runtimeHost ? ['runtime-host'] : []),
                            ...(view.capabilities.sshBootstrap ? ['ssh-bootstrap'] : [])
                          ]}
                          emptyLabel="node"
                        />
                      </div>
                      <div className="fabric-node-row-status">
                        <StatusTag status={view.node.status || "unknown"} />
                        <span>{formatPlatform(view.node)}</span>
                      </div>
                      <div className="fabric-node-row-metrics">
                        <span>{view.projects.length} projects</span>
                        <span>{view.runtimes.length} runtimes</span>
                        <span>{view.capabilities.transportState}</span>
                      </div>
                      <div className="fabric-node-row-time">
                        lastSeen {formatTime(view.node.lastSeenAt)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {selectedNode && (counts.nodes > 0) && (
            <SectionCard
              title={selectedNode?.node.name || selectedNode?.node.id || "节点属性详情"}
              extra={selectedNode ? <StatusTag status={selectedNode.node.status || "unknown"} /> : null}
            >
              <div className="fabric-node-detail">
                <div className="fabric-node-detail-strip">
                  <span>roles</span>
                  <div><TagList items={selectedNode.node.roles} emptyLabel="node" /></div>
                </div>
                <div className="fabric-node-detail-strip">
                  <span>platform</span>
                  <strong>{formatPlatform(selectedNode.node)}</strong>
                </div>
                <div className="fabric-node-detail-strip">
                  <span>capabilities</span>
                  <div>
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
                  </div>
                </div>
                <div className="fabric-node-detail-strip">
                  <span>actions</span>
                  <div><ActionSummary actions={selectedNode.actions} /></div>
                </div>

                <section className="fabric-node-detail-section">
                  <h3>Projects</h3>
                  {selectedNode.projects.length === 0 ? (
                    <p>暂无 project snapshot。</p>
                  ) : selectedNode.projects.map((project) => (
                    <div key={project.id} className="fabric-node-detail-item">
                      <strong>{project.name || project.id}</strong>
                      <span>{project.displayPath || project.vcs || project.id}</span>
                      <em>{project.permissions?.join(", ") || "permissions unknown"}</em>
                    </div>
                  ))}
                </section>

                <section className="fabric-node-detail-section">
                  <h3>Runtimes</h3>
                  {selectedNode.runtimes.length === 0 ? (
                    <p>暂无 provider runtime snapshot；该 node 目前不能作为 Codex / Claude / AGY / OpenCode runtime host。</p>
                  ) : selectedNode.runtimes.map((runtime) => (
                    <div key={runtime.id} className="fabric-node-detail-item">
                      <strong>{normalizeText(runtime.provider)} / {normalizeText(runtime.mode, "tui")}</strong>
                      <span>{runtime.version || "version unknown"}</span>
                      <em>{runtime.status || "available"}</em>
                    </div>
                  ))}
                </section>

                <section className="fabric-node-detail-section">
                  <h3>Action Gating</h3>
                  {selectedNode.actions.map((action) => (
                    <div key={action.id} className="fabric-node-detail-item">
                      <strong>{action.label}</strong>
                      <span>{action.eligible ? 'capability eligible' : 'capability blocked'}</span>
                      <em>{action.blockers.map(formatBlocker).join(' · ') || 'ready'}</em>
                    </div>
                  ))}
                </section>

                <section className="fabric-node-detail-section">
                  <h3>Transports</h3>
                  {selectedNode.transports.length === 0 ? (
                    <p>暂无 transport snapshot。</p>
                  ) : selectedNode.transports.map((transport) => (
                    <div key={transport.id} className="fabric-node-detail-item">
                      <strong>{transport.kind || transport.id}</strong>
                      <span>{transport.endpoint || transport.provider || "endpoint hidden"}</span>
                      <em>{getTransportHealth(transport)} · {formatTransportMeasurement(transport)}{transport.lastError ? ` · ${transport.lastError}` : ""}</em>
                    </div>
                  ))}
                </section>

                <section className="fabric-node-detail-section">
                  <h3>Relay Metadata</h3>
                  {selectedNode.relayNode ? (
                    <div className="fabric-relay-meta">
                      <span>capacityClass <strong>{selectedNode.relayNode.capacityClass || "tiny"}</strong></span>
                      <span>bandwidth <strong>{formatBandwidthKbps(selectedNode.relayNode.bandwidthLimitKbps)}</strong></span>
                      <span>status <strong>{selectedNode.relayNode.status || "unknown"}</strong></span>
                      <span>measurement <strong>{summarizeRelayMeasurement(selectedNode.transports)}</strong></span>
                      <span>measured <strong>{formatMeasuredAt(selectedNode.transports.find((transport) => transport.measurement)?.measurement?.measuredAt || selectedNode.relayNode.lastMeasuredAt)}</strong></span>
                      <span>score <strong>{resolveRelayScore(selectedNode.relayNode)}</strong></span>
                    </div>
                  ) : (
                    <p>该 node 未声明 relay-node metadata。</p>
                  )}
                </section>
              </div>
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
