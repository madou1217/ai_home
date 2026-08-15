import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Segmented, Select, Space, Spin, Tooltip, message } from 'antd';
import {
  ExportOutlined,
  ForkOutlined,
  GlobalOutlined,
  ImportOutlined,
  LinkOutlined,
  PlusOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type {
  DedicatedPortsResponse,
  ProxyCoreActionResponse,
  ProxyCoreStatus,
  ProxyNode,
  ProxyNodesResponse,
  ProxyProtocol,
  ProxySubscription,
  RoutingResponse,
  NetworkLayerStatus
} from '@/types';
import ProxyCoreStatusRail, { type CoreAction } from './ProxyCoreStatusRail';
import ProxyNetworkIntegrationPanel from './ProxyNetworkIntegrationPanel';
import ProxyExportModal from './ProxyExportModal';
import ProxyImportModal from './ProxyImportModal';
import ProxyNodeCard from './ProxyNodeCard';
import ProxyNodeEditorModal from './ProxyNodeEditorModal';
import ProxyRoutingModal from './ProxyRoutingModal';
import ProxyShareModal from './ProxyShareModal';
import ProxySubscriptionsModal from './ProxySubscriptionsModal';
import {
  FUNCTIONAL_GROUP_OPTIONS,
  getErrorMessage,
  getMutationMessage,
  isMutationApplied,
  PROTOCOL_OPTIONS
} from './proxy-pool-utils';

const NEW_NODE: Partial<ProxyNode> = {
  protocol: 'shadowsocks',
  port: 8388
};

export default function ProxyPoolPanel() {
  const [loading, setLoading] = useState(false);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [nodesData, setNodesData] = useState<ProxyNodesResponse | null>(null);
  const [subscriptions, setSubscriptions] = useState<ProxySubscription[]>([]);
  const [routingResponse, setRoutingResponse] = useState<RoutingResponse | null>(null);
  const [portsData, setPortsData] = useState<DedicatedPortsResponse | null>(null);
  const [coreStatus, setCoreStatus] = useState<ProxyCoreStatus | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkLayerStatus | null>(null);

  const [functionalGroup, setFunctionalGroup] = useState('all');
  const [countryFilter, setCountryFilter] = useState<string>();
  const [protocolFilter, setProtocolFilter] = useState<ProxyProtocol | 'all'>('all');
  const [pingingNodeId, setPingingNodeId] = useState<string | null>(null);
  const [batchPinging, setBatchPinging] = useState(false);
  const [coreAction, setCoreAction] = useState<CoreAction | null>(null);
  const [installPending, setInstallPending] = useState(false);

  const [editingNode, setEditingNode] = useState<Partial<ProxyNode> | null>(null);
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [shareNode, setShareNode] = useState<ProxyNode | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadErrors([]);
    const results = await Promise.allSettled([
      proxyPoolAPI.listNodes(),
      proxyPoolAPI.listSubscriptions(),
      proxyPoolAPI.getRouting(),
      proxyPoolAPI.getDedicatedPorts(),
      proxyPoolAPI.getCoreStatus(),
      proxyPoolAPI.getNetworkStatus()
    ] as const);

    const errors: string[] = [];
    const [nodesResult, subsResult, routingResult, portsResult, coreResult, networkResult] = results;
    if (nodesResult.status === 'fulfilled' && nodesResult.value.ok) {
      setNodesData(nodesResult.value);
    } else {
      setNodesData(null);
      errors.push(`节点列表：${nodesResult.status === 'rejected' ? getErrorMessage(nodesResult.reason, '读取失败') : '响应无效'}`);
    }
    if (subsResult.status === 'fulfilled' && subsResult.value.ok) {
      setSubscriptions(subsResult.value.subscriptions);
    } else {
      setSubscriptions([]);
      errors.push(`订阅源：${subsResult.status === 'rejected' ? getErrorMessage(subsResult.reason, '读取失败') : '响应无效'}`);
    }
    if (routingResult.status === 'fulfilled' && routingResult.value.ok) {
      setRoutingResponse(routingResult.value);
    } else {
      setRoutingResponse(null);
      errors.push(`分流状态：${routingResult.status === 'rejected' ? getErrorMessage(routingResult.reason, '读取失败') : '响应无效'}`);
    }
    if (portsResult.status === 'fulfilled' && portsResult.value.ok) {
      setPortsData(portsResult.value);
    } else {
      setPortsData(null);
      errors.push(`独立端口：${portsResult.status === 'rejected' ? getErrorMessage(portsResult.reason, '读取失败') : '响应无效'}`);
    }
    if (coreResult.status === 'fulfilled' && coreResult.value.ok) {
      setCoreStatus(coreResult.value.core);
    } else {
      setCoreStatus(null);
      errors.push(`代理核心：${coreResult.status === 'rejected' ? getErrorMessage(coreResult.reason, '读取失败') : '响应无效'}`);
    }
    if (networkResult.status === 'fulfilled' && networkResult.value.ok) {
      setNetworkStatus(networkResult.value);
    } else {
      setNetworkStatus(null);
      errors.push(`网络层：${networkResult.status === 'rejected' ? getErrorMessage(networkResult.reason, '读取失败') : '响应无效'}`);
    }
    setLoadErrors(errors);
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const activePortByNode = useMemo(() => new Map(
    (portsData?.active || [])
      .filter((item) => item.listening)
      .map((item) => [item.nodeId, item])
  ), [portsData]);

  const countryGroups = useMemo(() => (nodesData?.groups || []).filter((group) => (
    group.kind === 'country' || /^[A-Z]{2}$/.test(group.id)
  )), [nodesData]);

  const filteredNodes = useMemo(() => (nodesData?.nodes || []).filter((node) => {
    if (functionalGroup === 'dedicated' && !activePortByNode.has(node.id)) return false;
    if (functionalGroup === 'ai' && !node.tags?.includes('ai')) return false;
    if (functionalGroup === 'dev' && !node.tags?.includes('dev')) return false;
    if (countryFilter && node.countryCode !== countryFilter && node.group !== countryFilter) return false;
    return protocolFilter === 'all' || node.protocol === protocolFilter;
  }), [activePortByNode, countryFilter, functionalGroup, nodesData, protocolFilter]);

  const dataPlaneReady = coreStatus?.dataPlaneReady === true;
  const routing = routingResponse?.routing;

  const runCoreAction = async (action: CoreAction) => {
    setCoreAction(action);
    try {
      const handlers: Record<CoreAction, () => Promise<ProxyCoreActionResponse>> = {
        start: proxyPoolAPI.startCore,
        stop: proxyPoolAPI.stopCore,
        reload: proxyPoolAPI.reloadCore
      };
      const result = await handlers[action]();
      setCoreStatus(result.core);
      if (isMutationApplied(result)) {
        message.success(action === 'stop' ? '代理核心已停止' : '代理核心配置已应用');
        await fetchData();
      } else {
        message.error(result.message || result.error || '代理核心操作未生效');
      }
    } catch (error) {
      const response = (error as { response?: { data?: ProxyCoreActionResponse } })?.response?.data;
      if (response?.core) setCoreStatus(response.core);
      message.error(getErrorMessage(error, '代理核心操作失败'));
    } finally {
      setCoreAction(null);
    }
  };

  const installCore = async () => {
    if (installPending) return;
    setInstallPending(true);
    try {
      const planned = await proxyPoolAPI.planCoreInstall();
      if (!planned.ok || !planned.plan) {
        message.error(planned.message || planned.error || '无法生成 Mihomo 安装计划');
        return;
      }
      const accepted = window.confirm(
        `将从官方 Mihomo 发布源下载并校验 ${planned.plan.version}（${planned.plan.assetName}）。\n\n` +
        `文件摘要：${planned.plan.digest}\n安装到 AIH 托管目录。是否继续？`
      );
      if (!accepted) return;
      const result = await proxyPoolAPI.executeCoreInstall(planned.plan.planId, true);
      if (!result.ok) {
        message.error(result.message || result.error || 'Mihomo 安装失败');
        return;
      }
      message.success(`Mihomo ${result.version || planned.plan.version} 已安装，可启动核心`);
      await fetchData();
    } catch (error) {
      message.error(getErrorMessage(error, 'Mihomo 安装失败'));
    } finally {
      setInstallPending(false);
    }
  };

  const pingNode = async (nodeId: string) => {
    if (!dataPlaneReady) return;
    setPingingNodeId(nodeId);
    try {
      const result = await proxyPoolAPI.pingNode(nodeId);
      setNodesData((previous) => previous ? {
        ...previous,
        nodes: previous.nodes.map((node) => node.id === nodeId
          ? { ...node, latencyMs: result.reachable ? result.latencyMs : -1 }
          : node)
      } : previous);
      if (result.ok && result.reachable) {
        message.success(`真实代理延迟：${result.latencyMs} ms`);
      } else {
        message.warning(result.error || '节点未通过代理核心健康检查');
      }
    } catch (error) {
      message.error(getErrorMessage(error, '测速失败'));
    } finally {
      setPingingNodeId(null);
    }
  };

  const pingAll = async () => {
    if (!dataPlaneReady) return;
    setBatchPinging(true);
    try {
      const result = await proxyPoolAPI.pingAllNodes({
        group: countryFilter || (functionalGroup !== 'all' ? functionalGroup : undefined),
        protocol: protocolFilter !== 'all' ? protocolFilter : undefined
      });
      if (result.ok) {
        message.success(`完成 ${result.testedCount} 个节点的代理核心健康检查`);
        await fetchData();
      }
    } catch (error) {
      message.error(getErrorMessage(error, '批量测速失败'));
    } finally {
      setBatchPinging(false);
    }
  };

  const togglePort = async (node: ProxyNode) => {
    const active = activePortByNode.has(node.id);
    try {
      const result = await proxyPoolAPI.toggleDedicatedPort(node.id, !active);
      if (!isMutationApplied(result)) {
        message.warning(getMutationMessage(result, '独立端口操作未应用，原配置已保留'));
        return;
      }
      message.success(active
        ? '独立 mixed 端口已停止'
        : `独立 mixed 端口已监听 127.0.0.1:${result.port}`);
      await fetchData();
    } catch (error) {
      message.error(getErrorMessage(error, '独立端口操作失败'));
    }
  };

  const deleteNode = async (nodeId: string) => {
    try {
      const result = await proxyPoolAPI.deleteNode(nodeId);
      if (!isMutationApplied(result)) {
        message.warning(getMutationMessage(result, '删除未应用，原节点已保留'));
        return;
      }
      message.success('节点已删除');
      await fetchData();
    } catch (error) {
      message.error(getErrorMessage(error, '删除节点失败'));
    }
  };

  return (
    <div className="proxy-pool-panel">
      <ProxyCoreStatusRail
        core={coreStatus}
        pendingAction={coreAction}
        onAction={(action) => void runCoreAction(action)}
        onInstall={() => void installCore()}
        installPending={installPending}
      />

      <ProxyNetworkIntegrationPanel status={networkStatus} core={coreStatus} onRefresh={fetchData} />

      {loadErrors.length > 0 && (
        <Alert
          className="toolkit-load-errors"
          type="warning"
          showIcon
          message="部分状态读取失败"
          description={loadErrors.join('；')}
          action={<Button onClick={() => void fetchData()}>重试</Button>}
        />
      )}

      <div className="toolkit-stat-row">
        <StatisticCard.Group direction="row">
          <StatisticCard statistic={{
            title: '代理节点',
            value: nodesData?.total || 0,
            icon: <GlobalOutlined aria-hidden style={{ color: '#1677ff', fontSize: 24 }} />
          }} />
          <StatisticCard statistic={{
            title: '订阅源（手动同步）',
            value: subscriptions.length,
            icon: <LinkOutlined aria-hidden style={{ color: '#722ed1', fontSize: 24 }} />
          }} />
          <StatisticCard statistic={{
            title: '真实监听端口',
            value: `${activePortByNode.size} / ${portsData?.config.maxPorts || 32}`,
            valueStyle: { color: activePortByNode.size > 0 ? '#237804' : '#595959' },
            icon: <ForkOutlined aria-hidden style={{ color: '#389e0d', fontSize: 24 }} />
          }} />
          <StatisticCard statistic={{
            title: '数据面',
            value: dataPlaneReady ? 'READY' : 'OFFLINE',
            valueStyle: { color: dataPlaneReady ? '#237804' : '#cf1322', fontSize: 20 },
            icon: <SettingOutlined aria-hidden style={{ color: dataPlaneReady ? '#389e0d' : '#cf1322', fontSize: 24 }} />
          }} />
        </StatisticCard.Group>
      </div>

      <div className="toolkit-category-bar proxy-pool-toolbar">
        <Space size={12} wrap>
          <Segmented
            aria-label="功能分组"
            value={functionalGroup}
            onChange={(value) => setFunctionalGroup(String(value))}
            options={FUNCTIONAL_GROUP_OPTIONS}
          />
          <Select
            aria-label="国家或地区筛选"
            allowClear
            value={countryFilter}
            placeholder="国家 / 地区"
            onChange={setCountryFilter}
            style={{ minWidth: 150 }}
            options={countryGroups.map((group) => ({
              label: `${group.icon || ''} ${group.name} (${group.count})`.trim(),
              value: group.id
            }))}
          />
          <Select
            aria-label="代理协议筛选"
            value={protocolFilter}
            onChange={setProtocolFilter}
            style={{ minWidth: 150 }}
            options={PROTOCOL_OPTIONS}
          />
        </Space>
        <Space size={8} wrap>
          <Tooltip title={dataPlaneReady ? '通过 Mihomo API 测量真实代理延迟' : '代理核心未就绪'}>
            <Button
              icon={<ThunderboltOutlined />}
              loading={batchPinging}
              disabled={!dataPlaneReady}
              onClick={() => void pingAll()}
            >
              批量实测
            </Button>
          </Tooltip>
          <Button icon={<ForkOutlined />} onClick={() => setRoutingOpen(true)}>分流与出口</Button>
          <Button icon={<ExportOutlined />} onClick={() => setExportOpen(true)}>配置导出</Button>
          <Button icon={<LinkOutlined />} onClick={() => setSubscriptionsOpen(true)}>
            订阅源 ({subscriptions.length})
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入</Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingNode(NEW_NODE);
              setNodeEditorOpen(true);
            }}
          >
            添加节点
          </Button>
        </Space>
      </div>

      {(functionalGroup === 'ai' || functionalGroup === 'dev' || countryFilter) && (
        <Alert
          className="proxy-group-source"
          type="info"
          showIcon
          message="分组来源说明"
          description={functionalGroup === 'ai' || functionalGroup === 'dev'
            ? 'AI / 开发分组来自节点名称与标签的启发式分类，不代表订阅商原生线路能力。'
            : '国家分组优先使用节点显式地区字段；缺失时可能来自名称或服务器域名推断。'}
        />
      )}

      {loading && !nodesData ? (
        <div className="toolkit-loading" role="status" aria-label="正在加载代理池"><Spin size="large" /></div>
      ) : filteredNodes.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="当前筛选条件下没有节点"
          description="可以导入订阅 URL、节点配置文本或二维码图片，也可以手动添加节点。"
          action={<Button type="primary" onClick={() => setImportOpen(true)}>立即导入</Button>}
        />
      ) : (
        <div className="toolkit-grid proxy-node-grid">
          {filteredNodes.map((node) => (
            <ProxyNodeCard
              key={node.id}
              node={node}
              activePort={activePortByNode.get(node.id)}
              currentOutbound={routing?.activeOutboundNodeId === node.id}
              dataPlaneReady={dataPlaneReady}
              pinging={pingingNodeId === node.id}
              onPing={() => void pingNode(node.id)}
              onTogglePort={() => void togglePort(node)}
              onEdit={() => {
                setEditingNode(node);
                setNodeEditorOpen(true);
              }}
              onDelete={() => void deleteNode(node.id)}
              onShare={() => setShareNode(node)}
            />
          ))}
        </div>
      )}

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
    </div>
  );
}
