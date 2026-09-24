import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import { confirmAction } from '@/utils/confirm-action';
import { proxyPoolAPI } from '@/services/api';
import type {
  DedicatedPortsResponse,
  NetworkLayerStatus,
  ProxyCoreActionResponse,
  ProxyCoreStatus,
  ProxyNode,
  ProxyNodesResponse,
  ProxyProtocol,
  ProxySubscription,
  RoutingResponse
} from '@/types';
import type { CoreAction } from './ProxyCoreStatusRail';
import { getErrorMessage, getMutationMessage, isMutationApplied } from './proxy-pool-utils';

/** 新建节点的默认值（桌面与移动端「添加节点」共用）。 */
export const NEW_PROXY_NODE: Partial<ProxyNode> = {
  protocol: 'shadowsocks',
  port: 8388
};

/**
 * 代理池的数据层（桌面面板与移动端共用）：节点 / 订阅 / 分流 / 独立端口 / 核心 / 网络层
 * 六路状态并行读取，代理核心启停与安装、节点实测、独立端口开关与删除节点。
 */
export function useProxyPool() {
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
      const accepted = await confirmAction({
        title: `安装 Mihomo ${planned.plan.version}`,
        content: (
          <div className="toolkit-confirm-detail" data-break="all">
            {`将从官方 Mihomo 发布源下载并校验 ${planned.plan.version}（${planned.plan.assetName}）。\n\n文件摘要：${planned.plan.digest}\n安装到 AIH 托管目录。是否继续？`}
          </div>
        ),
        okText: '下载并安装',
      });
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

  return {
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
  };
}
