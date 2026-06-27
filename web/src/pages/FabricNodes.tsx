import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Skeleton, Space, Statistic, Tag, message } from 'antd';
import {
  ApartmentOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  LinkOutlined,
  ProjectOutlined,
  ReloadOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  buildFabricRegistryNodeViews,
  buildFabricRegistryRelayViews,
  readActiveFabricRegistry
} from '@/services/fabric-registry';
import type {
  FabricRegistryNode,
  FabricRegistryNodeView,
  FabricRegistryRelayNode,
  FabricRegistryResult,
  FabricRegistryTransport
} from '@/services/fabric-registry';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  addActiveControlPlaneProfileChangeListener,
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import type { ControlPlaneProfile } from '@/types';
import './FabricNodes.css';

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

function summarizeTransportHealth(transports: FabricRegistryTransport[]) {
  if (transports.length === 0) return 'none';
  const groups = transports.reduce<Record<string, number>>((acc, transport) => {
    const health = getTransportHealth(transport);
    acc[health] = (acc[health] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(groups)
    .map(([health, count]) => `${health} ${count}`)
    .join(' · ');
}

function resolveRelayScore(relay: FabricRegistryRelayNode) {
  if (relay.lastMeasuredAt) return 'measured / no score';
  return 'no measurement';
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

export default function FabricNodes() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<ControlPlaneProfile | null>(getInitialProfile);
  const [registry, setRegistry] = useState<FabricRegistryResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const nodeViews = useMemo<FabricRegistryNodeView[]>(
    () => registry ? buildFabricRegistryNodeViews(registry) : [],
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
      const nextViews = buildFabricRegistryNodeViews(result);
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
    refreshProfile();
    const unsubscribeProfiles = addControlPlaneProfilesChangeListener(refreshProfile);
    const unsubscribeActive = addActiveControlPlaneProfileChangeListener(refreshProfile);
    window.addEventListener('focus', refreshProfile);
    return () => {
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
    <div className="fabric-nodes-page animate__animated animate__fadeIn animate__faster">
      <section className="fabric-nodes-header">
        <div>
          <span>AIH Fabric</span>
          <h1>Nodes / Relay Health</h1>
          <p>
            当前 Server 的 role registry 工作台：查看 node、project、runtime 与 relay transport 健康。
          </p>
        </div>
        <Space size={8} wrap>
          <Tag color={readyProfile ? 'green' : 'gold'}>
            {readyProfile ? readyProfile.name : 'no ready profile'}
          </Tag>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => readyProfile && loadRegistry()}
            loading={loading}
            disabled={!readyProfile}
          >
            刷新
          </Button>
        </Space>
      </section>

      {!readyProfile && (
        <Alert
          type="warning"
          showIcon
          message="没有 ready server profile"
          description="请先完成 Server Setup 配对；Fabric Nodes 必须从已授权 server profile 读取 registry。"
          action={(
            <Button size="small" onClick={() => navigate('/server-setup')}>
              去配置
            </Button>
          )}
        />
      )}

      {error && readyProfile && (
        <Alert
          type="error"
          showIcon
          message="Role registry 读取失败"
          description={error}
        />
      )}

      {readyProfile && (
        <>
          <section className="fabric-active-server" aria-label="active Fabric server">
            <div>
              <span>active server</span>
              <strong>{readyProfile.name}</strong>
              <em>{readyProfile.endpoint}</em>
            </div>
            <div>
              <span>profile state</span>
              <StatusTag status={readyProfile.state} />
              <StatusTag status={readyProfile.authState} />
            </div>
            <div>
              <span>last checked</span>
              <strong>{formatTime(readyProfile.lastCheckedAt || readyProfile.updatedAt)}</strong>
            </div>
          </section>

          <section className="fabric-nodes-summary" aria-label="registry summary">
            <Statistic title="nodes" value={loading ? '-' : counts.nodes} prefix={<ClusterOutlined />} />
            <Statistic title="relayNodes" value={loading ? '-' : counts.relayNodes} prefix={<CloudServerOutlined />} />
            <Statistic title="projects" value={loading ? '-' : counts.projects} prefix={<ProjectOutlined />} />
            <Statistic title="runtimes" value={loading ? '-' : counts.runtimes} prefix={<ToolOutlined />} />
            <Statistic title="transports" value={loading ? '-' : counts.transports} prefix={<LinkOutlined />} />
          </section>

          {loading && !registry ? (
            <section className="fabric-nodes-panel">
              <Skeleton active paragraph={{ rows: 8 }} />
            </section>
          ) : counts.nodes === 0 ? (
            <section className="fabric-nodes-panel">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="registry 暂无 node。等待 node 通过 fabric registry publish 或后续 heartbeat 上报。"
              />
            </section>
          ) : (
            <div className="fabric-nodes-grid">
              <section className="fabric-nodes-panel fabric-nodes-panel--list">
                <div className="fabric-nodes-panel-head">
                  <div>
                    <h2>Node List</h2>
                    <p>来自 `/v0/fabric/registry` 的节点快照。</p>
                  </div>
                  <ApartmentOutlined />
                </div>
                <div className="fabric-nodes-list">
                  {nodeViews.map((view) => {
                    const active = selectedNode?.node.id === view.node.id;
                    return (
                      <button
                        key={view.node.id}
                        type="button"
                        className={`fabric-node-row${active ? ' fabric-node-row--active' : ''}`}
                        onClick={() => setSelectedNodeId(view.node.id)}
                        title={view.node.name || view.node.id}
                      >
                        <div className="fabric-node-row-main">
                          <strong>{view.node.name || view.node.id}</strong>
                          <span>{view.node.id}</span>
                        </div>
                        <div className="fabric-node-row-tags">
                          <TagList items={view.node.roles} emptyLabel="node" />
                        </div>
                        <div className="fabric-node-row-status">
                          <StatusTag status={view.node.status || 'unknown'} />
                          <span>{formatPlatform(view.node)}</span>
                        </div>
                        <div className="fabric-node-row-metrics">
                          <span>{view.projects.length} projects</span>
                          <span>{view.runtimes.length} runtimes</span>
                          <span>{summarizeTransportHealth(view.transports)}</span>
                        </div>
                        <div className="fabric-node-row-time">
                          lastSeen {formatTime(view.node.lastSeenAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="fabric-nodes-panel fabric-nodes-panel--detail">
                <div className="fabric-nodes-panel-head">
                  <div>
                    <h2>{selectedNode?.node.name || selectedNode?.node.id || 'Node Detail'}</h2>
                    <p>项目、runtime、transport 与 relay metadata 按 node 聚合展示。</p>
                  </div>
                  {selectedNode ? <StatusTag status={selectedNode.node.status || 'unknown'} /> : null}
                </div>

                {selectedNode && (
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
                      <div><TagList items={selectedNode.node.capabilities} emptyLabel="none" /></div>
                    </div>

                    <section className="fabric-node-detail-section">
                      <h3>Projects</h3>
                      {selectedNode.projects.length === 0 ? (
                        <p>暂无 project snapshot。</p>
                      ) : selectedNode.projects.map((project) => (
                        <div key={project.id} className="fabric-node-detail-item">
                          <strong>{project.name || project.id}</strong>
                          <span>{project.displayPath || project.vcs || project.id}</span>
                          <em>{project.permissions?.join(', ') || 'permissions unknown'}</em>
                        </div>
                      ))}
                    </section>

                    <section className="fabric-node-detail-section">
                      <h3>Runtimes</h3>
                      {selectedNode.runtimes.length === 0 ? (
                        <p>暂无 runtime snapshot。</p>
                      ) : selectedNode.runtimes.map((runtime) => (
                        <div key={runtime.id} className="fabric-node-detail-item">
                          <strong>{normalizeText(runtime.provider)} / {normalizeText(runtime.mode, 'tui')}</strong>
                          <span>{runtime.version || 'version unknown'}</span>
                          <em>{runtime.status || 'available'}</em>
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
                          <span>{transport.endpoint || transport.provider || 'endpoint hidden'}</span>
                          <em>{getTransportHealth(transport)}{transport.lastError ? ` · ${transport.lastError}` : ''}</em>
                        </div>
                      ))}
                    </section>

                    <section className="fabric-node-detail-section">
                      <h3>Relay Metadata</h3>
                      {selectedNode.relayNode ? (
                        <div className="fabric-relay-meta">
                          <span>capacityClass <strong>{selectedNode.relayNode.capacityClass || 'tiny'}</strong></span>
                          <span>bandwidth <strong>{formatBandwidthKbps(selectedNode.relayNode.bandwidthLimitKbps)}</strong></span>
                          <span>status <strong>{selectedNode.relayNode.status || 'unknown'}</strong></span>
                          <span>measured <strong>{formatMeasuredAt(selectedNode.relayNode.lastMeasuredAt)}</strong></span>
                          <span>score <strong>{resolveRelayScore(selectedNode.relayNode)}</strong></span>
                        </div>
                      ) : (
                        <p>该 node 未声明 relay-node metadata。</p>
                      )}
                    </section>
                  </div>
                )}
              </section>
            </div>
          )}

          <section className="fabric-nodes-panel fabric-nodes-panel--wide">
            <div className="fabric-nodes-panel-head">
              <div>
                <h2>Relay Health</h2>
                <p>当前只展示 registry 中的 relay metadata 和 transport health；没有真实 measurement 时标注 no measurement。</p>
              </div>
              <CloudServerOutlined />
            </div>

            {relayViews.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 relay node 注册。" />
            ) : (
              <div className="fabric-relay-list">
                {relayViews.map(({ relayNode, node, transports, health }) => (
                  <div key={relayNode.id} className="fabric-relay-row">
                    <div className="fabric-relay-main">
                      <strong>{node?.name || relayNode.nodeId}</strong>
                      <span>{relayNode.id}</span>
                    </div>
                    <div className="fabric-relay-meta">
                      <span>capacityClass <strong>{relayNode.capacityClass || 'tiny'}</strong></span>
                      <span>bandwidth <strong>{formatBandwidthKbps(relayNode.bandwidthLimitKbps)}</strong></span>
                      <span>status <strong>{relayNode.status || (relayNode.enabled ? 'online' : 'disabled')}</strong></span>
                      <span>health <strong>{health}</strong></span>
                      <span>measured <strong>{formatMeasuredAt(relayNode.lastMeasuredAt)}</strong></span>
                      <span>score <strong>{resolveRelayScore(relayNode)}</strong></span>
                    </div>
                    <div className="fabric-relay-transports">
                      {transports.length === 0 ? (
                        <Tag>transport none</Tag>
                      ) : transports.map((transport) => (
                        <Tag key={transport.id} color={getStatusColor(getTransportHealth(transport))}>
                          {transport.kind || transport.id}: {getTransportHealth(transport)}
                        </Tag>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
