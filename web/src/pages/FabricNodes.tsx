import './FabricNodes.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Collapse, Empty, List, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { readActiveFabricRegistry } from '@/services/fabric-registry';
import type {
  FabricNodeInventoryItem,
  FabricRegistryNode,
  FabricRegistryResult,
  FabricRegistryTransport,
  FabricRegistryTransportMeasurement
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
import { sshHostsAPI } from '@/services/api';

/* ============================================================================
 * 展示层辅助（仅本页用）：把 registry 的英文/代码字段翻译成大白话中文。
 * 不改数据层，只做“看不懂 → 看得懂”的映射。
 * ========================================================================== */

const ONLINE_STATES = ['available', 'healthy', 'online', 'ready', 'up'];
const DEGRADED_STATES = ['degraded', 'partial', 'pending', 'warning'];
const OFFLINE_STATES = ['disabled', 'down', 'failed', 'offline', 'unhealthy'];

type Liveness = 'online' | 'degraded' | 'offline' | 'unknown';

const LIVENESS_LABEL: Record<Liveness, string> = {
  online: '在线',
  degraded: '不稳定',
  offline: '离线',
  unknown: '状态未知'
};

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'Mac',
  linux: 'Linux',
  win32: 'Windows',
  windows: 'Windows'
};

const TRANSPORT_KIND_LABEL: Record<string, string> = {
  webrtc: 'WebRTC 直连',
  relay: '中继线路 (relay)',
  ssh: 'SSH 通道',
  ws: 'WebSocket',
  wss: 'WebSocket',
  tcp: 'TCP 直连'
};

const PROVIDER_LABEL: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  agy: 'AGY',
  opencode: 'OpenCode'
};

function lower(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '加载失败');
}

function livenessOf(status: unknown): Liveness {
  const value = lower(status);
  if (ONLINE_STATES.includes(value)) return 'online';
  if (DEGRADED_STATES.includes(value)) return 'degraded';
  if (OFFLINE_STATES.includes(value)) return 'offline';
  return 'unknown';
}

function formatTime(value: unknown) {
  const timestamp = Number(value || 0);
  if (!timestamp) return '从未';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return date.toLocaleString();
}

function platformLabel(node: FabricRegistryNode) {
  const key = lower(node.platform);
  return PLATFORM_LABEL[key] || node.platform || '未知平台';
}

function platformDetail(node: FabricRegistryNode) {
  return [node.platform, node.arch].map((item) => String(item || '').trim()).filter(Boolean).join(' / ') || '平台未知';
}

function providerLabel(provider: string) {
  return PROVIDER_LABEL[lower(provider)] || provider;
}

function transportKindLabel(kind: string) {
  return TRANSPORT_KIND_LABEL[lower(kind)] || (kind || '未知线路');
}

function formatBandwidthKbps(value: unknown) {
  const bandwidth = Number(value || 0);
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return '不限速';
  if (bandwidth >= 1000) return `${Math.round(bandwidth / 100) / 10} Mbps`;
  return `${Math.floor(bandwidth)} Kbps`;
}

/* ── SSH 开发机 ↔ Node 绑定（展示层，语义同 CLI 的 local-ssh-node-bindings）──
 * 「SSH 开发机」页配置的连接/工作区存在本地 server；registry 里的 node 不知道它们。
 * 这里按 工作区 remoteRoot ↔ 节点项目路径 做匹配，让节点能力如实显示「SSH 开发」。 */

interface LocalSshBinding {
  connectionLabel: string;
  workspaceLabel: string;
  target: string;
  port: number;
  remoteRoot: string;
}

function normalizeRemotePath(value: unknown) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text || '';
}

function buildSshWorkspaceBindings(connections: any[], workspaces: any[]): LocalSshBinding[] {
  const connectionById = new Map<string, any>();
  (Array.isArray(connections) ? connections : []).forEach((connection) => {
    if (connection && connection.id) connectionById.set(String(connection.id), connection);
  });
  return (Array.isArray(workspaces) ? workspaces : [])
    .map((workspace) => {
      const connection = workspace ? connectionById.get(String(workspace.connectionId || '')) : null;
      const remoteRoot = normalizeRemotePath(workspace?.remoteRoot);
      if (!connection || !connection.host || !remoteRoot) return null;
      return {
        connectionLabel: String(connection.label || connection.host),
        workspaceLabel: String(workspace.label || remoteRoot),
        target: connection.user ? `${connection.user}@${connection.host}` : String(connection.host),
        port: Number(connection.port) || 22,
        remoteRoot
      };
    })
    .filter(Boolean) as LocalSshBinding[];
}

function findNodeSshBindings(view: FabricNodeInventoryItem, bindings: LocalSshBinding[]): LocalSshBinding[] {
  if (!bindings.length) return [];
  const projectPaths = new Set(view.projects.map((project) => normalizeRemotePath(project.displayPath)).filter(Boolean));
  if (!projectPaths.size) return [];
  return bindings.filter((binding) => projectPaths.has(binding.remoteRoot));
}

/** 每台机器“能干什么”，大白话 + ✓/✗。 */
function capabilityRows(view: FabricNodeInventoryItem, sshBindings: LocalSshBinding[]) {
  const caps = view.capabilities;
  const providers = caps.runtimeProviders.filter(Boolean).map(providerLabel);
  const sshOk = caps.sshBootstrap || sshBindings.length > 0;
  const sshHint = sshBindings.length > 0
    ? `可经 SSH 开发机「${sshBindings[0].connectionLabel}」(${sshBindings[0].target}) 远程开发 · 工作区「${sshBindings[0].workspaceLabel}」`
    : (caps.sshBootstrap ? '能通过 SSH 远程开发' : '未配置：可在「SSH / Bootstrap」页添加连接和工作区');
  return [
    {
      ok: caps.runtimeHost,
      label: caps.runtimeHost && providers.length ? `跑AI(${caps.runtimeProviders.filter(Boolean).join('/')})` : '跑AI',
      hint: caps.runtimeHost ? `能在这台机器上跑：${providers.join(' / ')}` : '这台机器还没装可用的 AI 运行时'
    },
    {
      ok: caps.relayNode,
      label: '中继',
      hint: caps.relayNode ? '能帮别的机器转发流量（relay）' : '没有开启中继能力'
    },
    {
      ok: sshOk,
      label: 'SSH 开发',
      hint: sshHint
    }
  ];
}

/** 把 action 的英文 blocker 代码翻译成“为什么不能用”。 */
function describeProviderBlocker(provider: string, blockers: string[]) {
  const primary = blockers.find((code) => code && !code.startsWith('m4_')) || blockers[0] || '';
  const [code, , status] = primary.split(':');
  const name = providerLabel(provider);
  switch (code) {
    case 'provider_account_unavailable':
      return { headline: '未授权', detail: `这台机器没登录 ${name} 账号` };
    case 'missing_provider_runtime':
      return { headline: '未授权', detail: `这台机器没检测到 ${name} 运行时（可能未安装或未登录）` };
    case 'provider_runtime_not_ready':
      return { headline: '未就绪', detail: `${name} 运行时状态：${status || '未知'}` };
    case 'missing_project_snapshot':
      return { headline: '缺项目', detail: '这台机器还没有可打开的项目' };
    case 'missing_transport':
      return { headline: '没连上', detail: '这台机器暂时没有可用线路' };
    default:
      return { headline: '不可用', detail: primary || '暂不可用' };
  }
}

function describeMeasurement(measurement: FabricRegistryTransportMeasurement | null) {
  if (!measurement) return '尚未测量';
  const parts: string[] = [];
  if (measurement.rttMs && measurement.rttMs.count) parts.push(`延迟 p95 ${measurement.rttMs.p95}ms`);
  if (measurement.sampleCount && measurement.successRate !== null) {
    parts.push(`成功率 ${Math.round(measurement.successRate * 100)}%（${measurement.sampleCount} 次）`);
  } else if (measurement.successes || measurement.failures) {
    parts.push(`${measurement.successes}/${measurement.successes + measurement.failures} 成功`);
  }
  if (measurement.failureReason) parts.push(measurement.failureReason);
  return parts.join(' · ') || '已测量';
}

/** 挑一条“主线路”用于连接质量展示：优先有测量的，其次在线的，再退第一条。 */
function pickPrimaryTransport(transports: FabricRegistryTransport[]) {
  const measured = transports.find((transport) => transport.measurement);
  if (measured) return measured;
  const online = transports.find((transport) => livenessOf(transport.health) === 'online');
  return online || transports[0] || null;
}

function getInitialProfile() {
  const profiles = listControlPlaneProfiles();
  const active = resolveStoredActiveControlPlaneProfile(profiles, getActiveControlPlaneProfileId());
  return active.profile || null;
}

function LivenessDot({ liveness }: { liveness: Liveness }) {
  return <span className={`fabric-dot fabric-dot--${liveness}`} aria-hidden />;
}

function LivenessBadge({ status }: { status: unknown }) {
  const liveness = livenessOf(status);
  return (
    <span className={`fabric-liveness fabric-liveness--${liveness}`}>
      <LivenessDot liveness={liveness} />
      {LIVENESS_LABEL[liveness]}
    </span>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fabric-detail-block">
      <div className="fabric-detail-block__label">{label}</div>
      <div className="fabric-detail-block__body">{children}</div>
    </div>
  );
}

function SecondaryList<T>({ items, empty, getKey, render }: {
  items: T[];
  empty: string;
  getKey: (item: T) => string;
  render: (item: T) => { title: ReactNode; description: ReactNode };
}) {
  if (items.length === 0) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <List
      size="small"
      dataSource={items}
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

/* ============================================================================
 * 节点详情（右侧常驻栏）
 * ========================================================================== */

function NodeDetail({ view, sshBindings, onPendingAction, onOpenChat }: {
  view: FabricNodeInventoryItem;
  sshBindings: LocalSshBinding[];
  onPendingAction: (label: string) => void;
  onOpenChat: () => void;
}) {
  const { node } = view;
  const liveness = livenessOf(node.status);
  const offline = liveness === 'offline';
  const nodeSshBindings = useMemo(() => findNodeSshBindings(view, sshBindings), [view, sshBindings]);

  const openAction = view.actions.find((action) => action.id === 'open-project') || null;
  const sessionActions = view.actions.filter((action) => action.id.startsWith('start-session:'));
  const readySessions = sessionActions.filter((action) => action.eligible);
  const blockedSessions = sessionActions.filter((action) => !action.eligible);

  const primaryTransport = pickPrimaryTransport(view.transports);
  const transportState = view.capabilities.transportState;

  const canOpenProject = Boolean(openAction?.eligible) && !offline;

  return (
    <div className="fabric-detail">
      {/* 身份行 */}
      <div className="fabric-detail__identity">
        <div>
          <div className="fabric-detail__name" title={node.id}>{node.name || node.id}</div>
          <div className="fabric-detail__sub">
            {platformLabel(node)} · <span className="fabric-mono">{platformDetail(node)}</span>
          </div>
        </div>
        <LivenessBadge status={node.status} />
      </div>

      {/* 能力：它能干什么 */}
      <DetailBlock label="能力（这台机器能干什么）">
        <div className="fabric-caps">
          {capabilityRows(view, nodeSshBindings).map((row) => (
            <Tooltip key={row.label} title={row.hint}>
              <span className={`fabric-cap ${row.ok ? 'fabric-cap--ok' : 'fabric-cap--no'}`}>
                {row.ok ? '✓' : '✗'} {row.label}
              </span>
            </Tooltip>
          ))}
        </div>
      </DetailBlock>

      {/* 我能做：动作 */}
      <DetailBlock label="我现在能做什么">
        <Space wrap>
          <Button
            size="small"
            type="primary"
            disabled={!canOpenProject}
            onClick={() => onPendingAction('打开项目')}
          >
            打开项目
          </Button>
          {readySessions.length > 0 && (
            <Button
              size="small"
              type="primary"
              disabled={offline}
              onClick={onOpenChat}
            >
              发起会话
            </Button>
          )}
        </Space>
        {readySessions.length > 0 && !offline && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            可发起会话的 AI：{readySessions.map((action) => providerLabel(action.provider)).join(' / ')}。会话统一在「AI 会话」里进行，跟随当前 server。
          </Typography.Paragraph>
        )}
        {offline && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            节点离线，动作暂不可用。
          </Typography.Paragraph>
        )}
        {!offline && readySessions.length === 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            这台机器暂时没有可直接发起的 AI 会话（见下方原因）。
          </Typography.Paragraph>
        )}
        {blockedSessions.length > 0 && (
          <div className="fabric-provider-gaps">
            {blockedSessions.map((action) => {
              const gap = describeProviderBlocker(action.provider, action.blockers);
              return (
                <div key={action.id} className="fabric-provider-gap">
                  <span className="fabric-provider-gap__name">{providerLabel(action.provider)}</span>
                  <span className="fabric-provider-gap__headline">— {gap.headline}</span>
                  <span className="fabric-provider-gap__detail">{gap.detail}</span>
                </div>
              );
            })}
          </div>
        )}
      </DetailBlock>

      {/* 连接质量：并入原 Relay Health */}
      <DetailBlock label="连接质量">
        {primaryTransport ? (
          <div className="fabric-conn">
            <div className="fabric-conn__line">
              <strong>{transportKindLabel(primaryTransport.kind)}</strong>
              <LivenessBadge status={primaryTransport.health} />
              <span className="fabric-muted">{describeMeasurement(primaryTransport.measurement)}</span>
            </div>
            {primaryTransport.lastError && (
              <div className="fabric-conn__error">最近错误：{primaryTransport.lastError}</div>
            )}
            {transportState === 'degraded' && (
              <div className="fabric-conn__warn">线路不稳定（degraded），可能偶发断连。</div>
            )}
          </div>
        ) : (
          <Typography.Text type="secondary">还没有可用线路（未连接 / 未测量）。</Typography.Text>
        )}
        {view.relayNode && (
          <div className="fabric-conn__relay">
            作为中继：容量 {view.relayNode.capacityClass || 'tiny'} · 带宽 {formatBandwidthKbps(view.relayNode.bandwidthLimitKbps)}
            {' · '}状态 {LIVENESS_LABEL[livenessOf(view.relayNode.status)]}
          </div>
        )}
      </DetailBlock>

      {/* 次要信息：默认折叠 */}
      <Collapse
        ghost
        className="fabric-detail__more"
        items={[
          {
            key: 'projects',
            label: `项目（${view.projects.length}）`,
            children: (
              <SecondaryList
                items={view.projects}
                empty="暂无项目快照。"
                getKey={(project) => project.id}
                render={(project) => ({
                  title: project.name || project.id,
                  description: project.displayPath || project.vcs || project.id
                })}
              />
            )
          },
          {
            key: 'runtimes',
            label: `AI 运行时（${view.runtimes.length}）`,
            children: (
              <SecondaryList
                items={view.runtimes}
                empty="暂无运行时；这台机器目前不能作为 Codex / Claude / AGY / OpenCode 的宿主。"
                getKey={(runtime) => runtime.id}
                render={(runtime) => ({
                  title: `${providerLabel(runtime.provider)} · ${runtime.mode || 'tui'}`,
                  description: `${runtime.version || '版本未知'} · ${runtime.status || 'available'}`
                })}
              />
            )
          },
          {
            key: 'transports',
            label: `线路 / 传输（${view.transports.length}）`,
            children: (
              <SecondaryList
                items={view.transports}
                empty="暂无线路快照。"
                getKey={(transport) => transport.id}
                render={(transport) => ({
                  title: (
                    <span>
                      {transportKindLabel(transport.kind)}{' '}
                      <Tag color={livenessOf(transport.health) === 'online' ? 'green' : livenessOf(transport.health) === 'degraded' ? 'orange' : 'default'}>
                        {LIVENESS_LABEL[livenessOf(transport.health)]}
                      </Tag>
                    </span>
                  ),
                  description: `${describeMeasurement(transport.measurement)}${transport.lastError ? ` · ${transport.lastError}` : ''}`
                })}
              />
            )
          }
        ]}
      />

      <div className="fabric-detail__seen">最近可见：{formatTime(node.lastSeenAt)}</div>
    </div>
  );
}

/* ============================================================================
 * 页面
 * ========================================================================== */

export default function FabricNodes() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<ControlPlaneProfile | null>(getInitialProfile);
  const [registry, setRegistry] = useState<FabricRegistryResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sshBindings, setSshBindings] = useState<LocalSshBinding[]>([]);

  // SSH 开发机（本地 server 的连接/工作区）→ 节点能力桥。失败不阻塞页面，仅少显示 SSH 能力。
  const loadSshBindings = useCallback(async () => {
    try {
      const [connections, workspaces] = await Promise.all([
        sshHostsAPI.listConnections(),
        sshHostsAPI.listWorkspaces()
      ]);
      setSshBindings(buildSshWorkspaceBindings(connections, workspaces));
    } catch (_error) {
      setSshBindings([]);
    }
  }, []);

  useEffect(() => { void loadSshBindings(); }, [loadSshBindings]);

  const nodeViews = useMemo<FabricNodeInventoryItem[]>(
    () => (registry ? registry.nodeInventory : []),
    [registry]
  );
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

  const handlePendingAction = useCallback((label: string) => {
    message.info(`${label}：动作通道将在后续里程碑（M4）接入，当前仅展示可用性。`);
  }, []);

  const nodeCount = nodeViews.length;
  const firstLoading = loading && !registry;

  return (
    <PageScaffold
      ghost
      title={`节点总览${readyProfile && nodeCount ? `（${nodeCount}）` : ''}`}
      subTitle="每台能连上的机器都是一个 Node：它是什么机器、能干什么、你能对它做什么、连得好不好，一眼看清。"
      extra={
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={() => { if (readyProfile) { void loadRegistry(); void loadSshBindings(); } }}
          loading={loading}
          disabled={!readyProfile}
        >
          刷新
        </Button>
      }
    >
      {!readyProfile && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="还没有连上服务器"
          description="节点总览需要先连上一个已授权的服务器（Server Profile）才能读取机器列表。请先完成配对设置。"
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
          style={{ marginBottom: 16 }}
          message="读取节点数据失败"
          description={error}
        />
      )}

      {readyProfile && (
        <>
          <div className="fabric-topline">
            <span className="fabric-topline__label">服务器</span>
            <span className="fabric-mono">{readyProfile.endpoint}</span>
            <LivenessBadge status={readyProfile.state} />
            <span className="fabric-muted">检测于 {formatTime(readyProfile.lastCheckedAt || readyProfile.updatedAt)}</span>
          </div>

          <div className="fabric-workbench">
            {/* 左：节点列表 */}
            <div className="fabric-node-list">
              {firstLoading ? (
                <div className="fabric-node-list__loading">
                  <Spin />
                </div>
              ) : nodeCount === 0 ? (
                <Empty
                  className="fabric-node-list__empty"
                  description="还没有任何机器上线。请在需要的机器上启动 AIH 并加入本服务器。"
                />
              ) : (
                nodeViews.map((view) => {
                  const active = selectedNode?.node.id === view.node.id;
                  return (
                    <button
                      type="button"
                      key={view.node.id}
                      className={`fabric-node-item ${active ? 'fabric-node-item--active' : ''}`}
                      onClick={() => setSelectedNodeId(view.node.id)}
                    >
                      <LivenessDot liveness={livenessOf(view.node.status)} />
                      <span className="fabric-node-item__text">
                        <span className="fabric-node-item__name" title={view.node.id}>
                          {view.node.name || view.node.id}
                        </span>
                        <span className="fabric-node-item__sub">
                          {platformLabel(view.node)} · {LIVENESS_LABEL[livenessOf(view.node.status)]}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* 右：常驻详情栏 */}
            <div className="fabric-node-panel">
              {selectedNode ? (
                <NodeDetail view={selectedNode} sshBindings={sshBindings} onPendingAction={handlePendingAction} onOpenChat={() => navigate('/chat')} />
              ) : firstLoading ? (
                <div className="fabric-node-panel__placeholder">
                  <Spin />
                </div>
              ) : (
                <Empty
                  className="fabric-node-panel__placeholder"
                  description="选择左侧一台机器查看详情。"
                />
              )}
            </div>
          </div>
        </>
      )}
    </PageScaffold>
  );
}
