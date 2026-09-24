import { useState } from 'react';
import { Input, Select } from 'antd';
import {
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ForkOutlined,
  GlobalOutlined,
  ImportOutlined,
  LinkOutlined,
  PlusOutlined,
  PoweroffOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import ProxyExportModal from '@/components/toolkit/proxy-pool/ProxyExportModal';
import ProxyImportModal from '@/components/toolkit/proxy-pool/ProxyImportModal';
import ProxyNodeEditorModal from '@/components/toolkit/proxy-pool/ProxyNodeEditorModal';
import ProxyRoutingModal from '@/components/toolkit/proxy-pool/ProxyRoutingModal';
import ProxyShareModal from '@/components/toolkit/proxy-pool/ProxyShareModal';
import ProxySubscriptionsModal from '@/components/toolkit/proxy-pool/ProxySubscriptionsModal';
import {
  copyText,
  coreStatusPresentation,
  FUNCTIONAL_GROUP_OPTIONS,
  PROTOCOL_OPTIONS
} from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import {
  networkRouteLabel,
  TUN_STACK_OPTIONS,
  useNetworkIntegration
} from '@/components/toolkit/proxy-pool/use-network-integration';
import { NEW_PROXY_NODE, useProxyPool } from '@/components/toolkit/proxy-pool/use-proxy-pool';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudCard,
  HudChips,
  HudField,
  HudSection,
  KeyValue,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { HudTone, SwipeAction } from '@/mobile/ui';
import type { DedicatedPortsActiveServer, NetworkLayerStatus, ProxyCoreStatus, ProxyNode } from '@/types';
import { confirmAction } from '@/utils/confirm-action';
import { ActionButton, InlineError, Note, PanelToolbar, StatusText } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const CORE_TONES: Record<ReturnType<typeof coreStatusPresentation>['type'], HudTone> = {
  info: 'info',
  success: 'ok',
  warning: 'warn',
  error: 'err'
};

/** 节点延迟读数：阈值与桌面 LatencyBadge 相同（<180 ok / <400 warn / 其余 err，负数 = 不可达）。 */
function latencyStatus(latency: number | null | undefined) {
  if (latency === undefined || latency === null) return <StatusText tone="muted">未实测</StatusText>;
  if (latency < 0) return <StatusText tone="err">不可达</StatusText>;
  const tone: HudTone = latency < 180 ? 'ok' : latency < 400 ? 'warn' : 'err';
  return <StatusText tone={tone}>{`${latency} ms`}</StatusText>;
}

/** 代理池与分流：Mihomo 核心、网络层接管、节点清单（实测 / 独立端口 / 分享 / 编辑 / 删除）与订阅、分流、导入导出弹窗。 */
export default function ProxyPoolPanel() {
  const {
    loading,
    loadErrors,
    nodesData,
    subscriptions,
    routingResponse,
    setRoutingResponse,
    portsData,
    coreStatus,
    networkStatus,
    functionalGroup,
    setFunctionalGroup,
    countryFilter,
    setCountryFilter,
    protocolFilter,
    setProtocolFilter,
    pingingNodeId,
    batchPinging,
    coreAction,
    installPending,
    fetchData,
    activePortByNode,
    countryGroups,
    filteredNodes,
    dataPlaneReady,
    routing,
    runCoreAction,
    installCore,
    pingNode,
    pingAll,
    togglePort,
    deleteNode
  } = useProxyPool();

  const [editingNode, setEditingNode] = useState<Partial<ProxyNode> | null>(null);
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [shareNode, setShareNode] = useState<ProxyNode | null>(null);
  const [detailId, setDetailId] = useState('');

  const detail = (nodesData?.nodes || []).find((node) => node.id === detailId) || null;

  const confirmDelete = async (node: ProxyNode) => {
    const accepted = await confirmAction({
      title: '删除此节点？',
      content: '该操作也会移除其独立端口映射。',
      okText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!accepted) return;
    setDetailId('');
    await deleteNode(node.id);
  };

  const editNode = (node: Partial<ProxyNode>) => {
    setEditingNode(node);
    setNodeEditorOpen(true);
  };

  const nodeActions = (node: ProxyNode): SwipeAction[] => {
    const activePort = activePortByNode.get(node.id);
    return [
      {
        key: 'ping',
        label: pingingNodeId === node.id ? '实测中' : '实测',
        icon: <ThunderboltOutlined />,
        disabled: !dataPlaneReady || pingingNodeId === node.id,
        onAction: () => void pingNode(node.id)
      },
      {
        key: 'port',
        label: activePort ? '关端口' : '独立端口',
        icon: <ForkOutlined />,
        tone: 'primary',
        disabled: !dataPlaneReady,
        onAction: () => void togglePort(node)
      },
      {
        key: 'delete',
        label: '删除',
        icon: <DeleteOutlined />,
        tone: 'danger',
        onAction: () => void confirmDelete(node)
      }
    ];
  };

  if (loading && !nodesData && !coreStatus) return <MobileBoot label="LOADING PROXY POOL" />;

  return (
    <>
      <PanelToolbar status={dataPlaneReady ? '数据面 READY' : '数据面 OFFLINE'} refreshLabel="重新读取" refreshing={loading} onRefresh={() => void fetchData()} />

      <CoreStatusCard
        core={coreStatus}
        pendingAction={coreAction}
        installPending={installPending}
        onAction={(action) => void runCoreAction(action)}
        onInstall={() => void installCore()}
      />

      <NetworkTakeoverCard status={networkStatus} core={coreStatus} onRefresh={fetchData} />

      {loadErrors.length > 0 ? (
        <InlineError title="部分状态读取失败" detail={loadErrors.join('；')} onRetry={() => void fetchData()} retrying={loading} />
      ) : null}

      <TelemetryGrid>
        <TelemetryTile label="代理节点" value={nodesData?.total || 0} tone="info" />
        <TelemetryTile label="订阅源（手动同步）" value={subscriptions.length} tone="info" />
        <TelemetryTile
          label="真实监听端口"
          value={`${activePortByNode.size} / ${portsData?.config.maxPorts || 32}`}
          tone={activePortByNode.size > 0 ? 'ok' : 'muted'}
          led={activePortByNode.size > 0 ? 'live' : false}
        />
        <TelemetryTile label="数据面" value={dataPlaneReady ? 'READY' : 'OFFLINE'} tone={dataPlaneReady ? 'ok' : 'err'} led />
      </TelemetryGrid>

      <div className={styles.actionGrid}>
        <ActionButton icon={<ThunderboltOutlined />} label="批量实测" loading={batchPinging} disabled={!dataPlaneReady} onClick={() => void pingAll()} />
        <ActionButton icon={<ForkOutlined />} label="分流与出口" onClick={() => setRoutingOpen(true)} />
        <ActionButton icon={<ExportOutlined />} label="配置导出" onClick={() => setExportOpen(true)} />
        <ActionButton icon={<LinkOutlined />} label={`订阅源 (${subscriptions.length})`} onClick={() => setSubscriptionsOpen(true)} />
        <ActionButton icon={<ImportOutlined />} label="导入" onClick={() => setImportOpen(true)} />
        <ActionButton icon={<PlusOutlined />} label="添加节点" tone="primary" onClick={() => editNode(NEW_PROXY_NODE)} />
      </div>
      {!dataPlaneReady ? <span className={styles.hint}>代理核心未就绪：测速、独立端口与分流切换保持禁用。</span> : null}

      <HudChips ariaLabel="功能分组" value={functionalGroup} onChange={setFunctionalGroup} items={FUNCTIONAL_GROUP_OPTIONS.map((item) => ({ key: item.value, label: item.label }))} />
      <div className={styles.filterRow}>
        <Select
          aria-label="国家或地区筛选"
          allowClear
          value={countryFilter}
          placeholder="国家 / 地区"
          onChange={setCountryFilter}
          options={countryGroups.map((group) => ({
            label: `${group.icon || ''} ${group.name} (${group.count})`.trim(),
            value: group.id
          }))}
        />
        <Select aria-label="代理协议筛选" value={protocolFilter} onChange={setProtocolFilter} options={PROTOCOL_OPTIONS} />
      </div>

      {(functionalGroup === 'ai' || functionalGroup === 'dev' || countryFilter) ? (
        <Note tone="info" title="分组来源说明">
          {functionalGroup === 'ai' || functionalGroup === 'dev'
            ? 'AI / 开发分组来自节点名称与标签的启发式分类，不代表订阅商原生线路能力。'
            : '国家分组优先使用节点显式地区字段；缺失时可能来自名称或服务器域名推断。'}
        </Note>
      ) : null}

      <HudSection title="节点" code="NODES" count={filteredNodes.length}>
        {filteredNodes.length === 0 ? (
          <EmptySignal
            title="NO NODES"
            description="当前筛选条件下没有节点。可以导入订阅 URL、节点配置文本或二维码图片，也可以手动添加节点。"
            action={<ActionButton icon={<ImportOutlined />} label="立即导入" tone="primary" onClick={() => setImportOpen(true)} />}
          />
        ) : (
          <MonoList ariaLabel="代理节点">
            {filteredNodes.map((node) => {
              const activePort = activePortByNode.get(node.id);
              const currentOutbound = routing?.activeOutboundNodeId === node.id;
              return (
                <SwipeRow key={node.id} actions={nodeActions(node)} onTap={() => setDetailId(node.id)} ariaLabel={`${node.name} 详情`}>
                  <span className={`mhud-row__icon ${styles.flag}`} aria-hidden="true">{node.countryFlag || '🌐'}</span>
                  <span className="mhud-row__main">
                    <span className={`mhud-row__title${currentOutbound ? ` ${styles.outbound}` : ''}`}>{node.name}</span>
                    <span className="mhud-row__meta">{node.protocol.toUpperCase()} · {node.server}:{node.port}</span>
                  </span>
                  <span className="mhud-row__side">
                    {pingingNodeId === node.id ? <StatusText tone="info" live>实测中</StatusText> : latencyStatus(node.latencyMs)}
                    {currentOutbound ? <StatusText tone="warn">当前出口</StatusText> : null}
                    {activePort ? <StatusText tone="ok" live>{`:${activePort.port}`}</StatusText> : null}
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
      </HudSection>

      <DetailSheet
        open={Boolean(detail)}
        onClose={() => setDetailId('')}
        code={detail ? `NODE // ${detail.protocol.toUpperCase()}` : 'NODE'}
        title={detail ? `${detail.countryFlag || '🌐'} ${detail.name}` : '节点'}
        footer={detail ? (
          <>
            <ActionButton
              icon={<ThunderboltOutlined />}
              label="实测"
              loading={pingingNodeId === detail.id}
              disabled={!dataPlaneReady}
              onClick={() => void pingNode(detail.id)}
            />
            <ActionButton
              icon={<ForkOutlined />}
              label={activePortByNode.has(detail.id) ? '关闭端口' : '独立端口'}
              tone="primary"
              disabled={!dataPlaneReady}
              onClick={() => void togglePort(detail)}
            />
            <ActionButton
              icon={<EditOutlined />}
              label="编辑"
              onClick={() => editNode(detail)}
            />
          </>
        ) : null}
      >
        {detail ? (
          <NodeDetail
            node={detail}
            activePort={activePortByNode.get(detail.id)}
            currentOutbound={routing?.activeOutboundNodeId === detail.id}
            dataPlaneReady={dataPlaneReady}
            onShare={() => setShareNode(detail)}
            onDelete={() => void confirmDelete(detail)}
          />
        ) : null}
      </DetailSheet>

      <ProxyNodeEditorModal
        open={nodeEditorOpen}
        node={editingNode}
        onClose={() => setNodeEditorOpen(false)}
        onSaved={fetchData}
      />
      <ProxyImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={fetchData} />
      <ProxyExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <ProxySubscriptionsModal
        open={subscriptionsOpen}
        subscriptions={subscriptions}
        onClose={() => setSubscriptionsOpen(false)}
        onChanged={fetchData}
      />
      <ProxyRoutingModal
        open={routingOpen}
        dataPlaneReady={dataPlaneReady}
        nodes={nodesData?.nodes || []}
        routingResponse={routingResponse}
        onClose={() => setRoutingOpen(false)}
        onChanged={setRoutingResponse}
      />
      <ProxyShareModal open={Boolean(shareNode)} node={shareNode} onClose={() => setShareNode(null)} />
    </>
  );
}

function NodeDetail({ node, activePort, currentOutbound, dataPlaneReady, onShare, onDelete }: {
  node: ProxyNode;
  activePort?: DedicatedPortsActiveServer;
  currentOutbound: boolean;
  dataPlaneReady: boolean;
  onShare: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={styles.sheetStack}>
      <KeyValue
        rows={[
          { key: 'latency', label: '延迟', value: latencyStatus(node.latencyMs) },
          { key: 'server', label: '服务器', value: `${node.server}:${node.port}` },
          ...(node.cipher ? [{ key: 'cipher', label: '加密', value: node.cipher }] : []),
          ...(node.sni ? [{ key: 'sni', label: 'SNI', value: node.sni }] : []),
          ...(activePort ? [{ key: 'port', label: '本地 mixed', value: <StatusText tone="ok" live>{`127.0.0.1:${activePort.port}`}</StatusText> }] : []),
          ...(currentOutbound ? [{ key: 'outbound', label: '出口', value: <StatusText tone="warn">当前出口</StatusText> }] : [])
        ]}
      />
      <p className={styles.hint}>
        {dataPlaneReady ? '实测由 Mihomo 执行；独立端口同时接受 HTTP 与 SOCKS5 客户端。' : '代理核心未就绪：实测与独立端口不可用。'}
      </p>
      <div className={styles.buttonRow}>
        <ActionButton icon={<QrcodeOutlined />} label="分享" disabled={!node.rawUri} onClick={onShare} />
        <ActionButton icon={<DeleteOutlined />} label="删除" tone="danger" onClick={onDelete} />
      </div>
    </div>
  );
}

function CoreStatusCard({ core, pendingAction, installPending, onAction, onInstall }: {
  core: ProxyCoreStatus | null;
  pendingAction: 'start' | 'stop' | 'reload' | null;
  installPending: boolean;
  onAction: (action: 'start' | 'stop' | 'reload') => void;
  onInstall: () => void;
}) {
  const presentation = coreStatusPresentation(core);
  const tone = CORE_TONES[presentation.type];
  return (
    <HudCard
      code="MIHOMO CORE"
      title={presentation.title}
      tone={tone}
      extra={<StatusText tone={tone} live={Boolean(core?.running && core.dataPlaneReady)}>{core?.running ? 'RUNNING' : core?.installed ? 'STOPPED' : core ? 'MISSING' : 'READING'}</StatusText>}
    >
      <p className={styles.prose}>{presentation.description}</p>
      {core && !core.installed ? (
        <div className={styles.buttonRow}>
          <ActionButton icon={<CloudDownloadOutlined />} label="自动安装 Mihomo" tone="primary" loading={installPending} onClick={onInstall} />
          <ActionButton icon={<LinkOutlined />} label="官方发布页" href="https://github.com/MetaCubeX/mihomo/releases" />
        </div>
      ) : null}
      {core?.installed && !core.running ? (
        <ActionButton icon={<PoweroffOutlined />} label="启动核心" tone="primary" loading={pendingAction === 'start'} onClick={() => onAction('start')} />
      ) : null}
      {core?.running ? (
        <>
          {core.mixedProxyUrl ? (
            <ActionButton
              icon={<CopyOutlined />}
              label={core.mixedProxyUrl}
              onClick={() => void copyText(core.mixedProxyUrl || '', '当前 mixed 代理地址已复制')}
            />
          ) : null}
          <div className={styles.buttonRow}>
            <ActionButton icon={<ReloadOutlined />} label="校验并重载" loading={pendingAction === 'reload'} onClick={() => onAction('reload')} />
            <ActionButton icon={<PoweroffOutlined />} label="停止核心" tone="danger" loading={pendingAction === 'stop'} onClick={() => onAction('stop')} />
          </div>
        </>
      ) : null}
    </HudCard>
  );
}

function NetworkTakeoverCard({ status, core, onRefresh }: {
  status: NetworkLayerStatus | null;
  core: ProxyCoreStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const {
    service,
    setService,
    tunStack,
    setTunStack,
    pending,
    externalTun,
    tunEnabled,
    enableSystemProxy,
    disableSystemProxy,
    enableTun,
    disableTun
  } = useNetworkIntegration(core, status, onRefresh);

  return (
    <HudCard
      code="NETWORK LAYER"
      title="网络层接管"
      tone={status?.effectiveRouteKnown ? 'ok' : 'warn'}
    >
      <span className={`mhud-status mhud-tone--${status?.effectiveRouteKnown ? 'ok' : 'warn'} ${styles.wrapStatus}`}>{networkRouteLabel(status)}</span>
      {externalTun ? (
        <Note tone="warn" title={`检测到外部 TUN：${status?.tun.owner || '未知工具'}`}>
          AIH 不会停止、修改或抢占现有代理工具。系统代理和 AIH TUN 接管按钮已保护性禁用。
        </Note>
      ) : null}
      {!status ? <Note tone="info">正在读取系统代理、TUN 和路由状态</Note> : null}
      {status && !status.effectiveRouteKnown && !externalTun ? (
        <Note tone="info" title="当前没有可确认的显式代理路径">
          direct-unknown 只表示没有读到系统 HTTP/SOCKS 开关，不代表没有透明代理或 VPN。
        </Note>
      ) : null}

      <HudField label="macOS 网络服务">
        <Input value={service} onChange={(event) => setService(event.target.value)} placeholder="例如 Wi-Fi" />
      </HudField>
      <div className={styles.buttonRow}>
        <ActionButton
          icon={<GlobalOutlined />}
          label="启用系统代理"
          loading={pending === 'proxy-enable'}
          disabled={externalTun || !service.trim() || !core?.dataPlaneReady}
          onClick={() => void enableSystemProxy()}
        />
        <ActionButton
          label="关闭系统代理"
          loading={pending === 'proxy-disable'}
          disabled={externalTun || !service.trim()}
          onClick={() => void disableSystemProxy()}
        />
      </div>

      <HudField label="AIH TUN 模式">
        <Select value={tunStack} onChange={setTunStack} options={TUN_STACK_OPTIONS} aria-label="AIH TUN 模式" />
      </HudField>
      <div className={styles.buttonRow}>
        <ActionButton
          icon={<ThunderboltOutlined />}
          label="启用 AIH TUN"
          loading={pending === 'tun-enable'}
          disabled={externalTun || tunEnabled || !core?.installed}
          onClick={() => void enableTun()}
        />
        <ActionButton
          label="停用 AIH TUN"
          loading={pending === 'tun-disable'}
          disabled={externalTun || !tunEnabled}
          onClick={() => void disableTun()}
        />
      </div>
    </HudCard>
  );
}
