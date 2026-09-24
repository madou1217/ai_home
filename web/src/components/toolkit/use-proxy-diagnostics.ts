import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import { proxyPoolAPI, toolkitAPI } from '@/services/api';
import type { ConnectivityResponse, NetworkLayerStatus, ProxyCoreStatus, ProxyStatusResponse } from '@/types';

export type ProxyTarget = 'git' | 'npm';
export type ProbeRoute = 'direct' | 'proxy';

export interface DetectedProxySource {
  label: string;
  value: string;
  origin: string;
}

export function uniqueProxySources(data: ProxyStatusResponse | null, core: ProxyCoreStatus | null) {
  if (!data) return [];
  const candidates: DetectedProxySource[] = [
    { label: 'AIH 代理池 mixed', value: core?.mixedProxyUrl || '', origin: 'Mihomo 数据面就绪状态' },
    { label: '系统 HTTP', value: data.system?.httpProxy || '', origin: '操作系统代理探测' },
    { label: '系统 HTTPS', value: data.system?.httpsProxy || '', origin: '操作系统代理探测' },
    { label: '系统 SOCKS', value: data.system?.socksProxy || '', origin: '操作系统代理探测' },
    { label: '进程 HTTP_PROXY', value: data.env.httpProxy || '', origin: 'AIH 服务进程环境' },
    { label: '进程 HTTPS_PROXY', value: data.env.httpsProxy || '', origin: 'AIH 服务进程环境' },
    { label: '进程 ALL_PROXY', value: data.env.allProxy || '', origin: 'AIH 服务进程环境' }
  ].filter((item) => item.value.trim());

  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

export function systemProxyObservation(data: ProxyStatusResponse | null) {
  if (!data?.system) {
    return { value: '当前接口不支持', detail: '未返回系统代理探测对象', tone: 'warning' as const };
  }
  if (data.system.enabled) {
    return {
      value: '检测到已启用代理',
      detail: `${data.system.platform} · ${data.system.httpProxy || data.system.httpsProxy || data.system.socksProxy || '地址信息不完整'}`,
      tone: 'success' as const
    };
  }
  if (data.system.probeStatus === 'error') {
    return { value: '系统探测失败', detail: `${data.system.source || data.system.platform} 返回错误`, tone: 'danger' as const };
  }
  if (data.system.probeStatus === 'unsupported') {
    return { value: '当前平台探测不可用', detail: `${data.system.source || data.system.platform} 不受支持或命令不存在`, tone: 'warning' as const };
  }
  return {
    value: '未检测到启用值',
    detail: `${data.system.platform} 探测结果为空；不等同于所有网络层均为直连`,
    tone: 'neutral' as const
  };
}

export function effectiveRouteLabel(networkLayer?: NetworkLayerStatus) {
  if (!networkLayer) return '未读取网络层状态';
  if (networkLayer.effectiveRoute === 'tun') {
    return `实际网络层：TUN（${networkLayer.tun.owner || '未知所有者'}）`;
  }
  if (networkLayer.effectiveRoute === 'system-proxy') return '实际网络层：系统代理';
  if (networkLayer.effectiveRoute === 'direct-unknown') return '未发现显式代理，透明网络层仍可能接管';
  return '实际网络层：未知';
}

function apiError(error: unknown, fallback: string) {
  const candidate = error as { message?: string; response?: { data?: { message?: string; error?: string } } };
  return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
}

/**
 * 网络与代理诊断的数据层（桌面面板与移动端共用）：系统 / 进程代理探测、
 * 真实来源应用到 Git / npm、手动写入与清除，以及直连 / 代理池两种路由的端点响应测试。
 */
export function useProxyDiagnostics() {
  const [proxyData, setProxyData] = useState<ProxyStatusResponse | null>(null);
  const [proxyLoading, setProxyLoading] = useState(true);
  const [proxyError, setProxyError] = useState('');
  const [coreStatus, setCoreStatus] = useState<ProxyCoreStatus | null>(null);
  const [coreError, setCoreError] = useState('');
  const [connectivityData, setConnectivityData] = useState<ConnectivityResponse | null>(null);
  const [connectivityLoading, setConnectivityLoading] = useState(true);
  const [connectivityError, setConnectivityError] = useState('');
  const [gitInput, setGitInput] = useState('');
  const [npmInput, setNpmInput] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [savingTarget, setSavingTarget] = useState<ProxyTarget | ''>('');
  const [probeRoute, setProbeRoute] = useState<ProbeRoute>('direct');

  const fetchProxy = useCallback(async () => {
    setProxyLoading(true);
    setProxyError('');
    try {
      setCoreError('');
      const [proxyResult, coreResult] = await Promise.allSettled([
        toolkitAPI.getProxy(),
        proxyPoolAPI.getCoreStatus()
      ]);
      if (coreResult.status === 'fulfilled' && coreResult.value.ok) {
        setCoreStatus(coreResult.value.core);
      } else {
        setCoreStatus(null);
        setCoreError(coreResult.status === 'rejected' ? apiError(coreResult.reason, '代理池状态读取失败') : '代理池状态不可用');
      }
      if (proxyResult.status === 'rejected' || !proxyResult.value.ok) {
        setProxyData(null);
        setGitInput('');
        setNpmInput('');
        throw proxyResult.status === 'rejected' ? proxyResult.reason : new Error('代理状态接口未返回可用结果');
      }
      const response = proxyResult.value;
      setProxyData(response);
      setGitInput(response.tools.git.httpProxy || response.tools.git.httpsProxy || '');
      setNpmInput(response.tools.npm.httpProxy || response.tools.npm.httpsProxy || '');
    } catch (requestError: unknown) {
      setProxyError(apiError(requestError, '读取代理状态失败'));
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const testConnectivity = useCallback(async (route: ProbeRoute) => {
    setConnectivityLoading(true);
    setConnectivityError('');
    setConnectivityData(null);
    try {
      const proxyUrl = route === 'proxy' ? coreStatus?.mixedProxyUrl || '' : undefined;
      if (route === 'proxy' && !proxyUrl) throw new Error('Mihomo 数据面未就绪，不能执行代理路由测试');
      const response = await toolkitAPI.testConnectivity({ route, proxyUrl });
      if (!response.ok) throw new Error('连通性接口未返回可用结果');
      setConnectivityData(response);
    } catch (requestError: unknown) {
      setConnectivityError(apiError(requestError, '端点连通性测试失败'));
    } finally {
      setConnectivityLoading(false);
    }
  }, [coreStatus?.mixedProxyUrl]);

  useEffect(() => {
    void fetchProxy();
  }, [fetchProxy]);

  useEffect(() => {
    void testConnectivity(probeRoute);
  }, [probeRoute, testConnectivity]);

  const detectedSources = useMemo(() => uniqueProxySources(proxyData, coreStatus), [coreStatus, proxyData]);

  useEffect(() => {
    setSelectedSource((current) => detectedSources.some((source) => source.value === current)
      ? current
      : (detectedSources[0]?.value || ''));
  }, [detectedSources]);

  const observation = systemProxyObservation(proxyData);
  const reachableCount = connectivityData?.results.filter((result) => result.reachable).length || 0;

  const saveProxy = async (target: ProxyTarget, value: string, action: string) => {
    setSavingTarget(target);
    try {
      const response = await toolkitAPI.setProxy(target, value.trim());
      if (!response.ok) throw new Error(response.message || response.error || '代理写入接口返回失败');
      await fetchProxy();
      message.success(`${target === 'git' ? 'Git' : 'npm'} ${action}`);
    } catch (requestError: unknown) {
      const detail = apiError(requestError, '写入代理失败');
      message.error(detail);
    } finally {
      setSavingTarget('');
    }
  };

  return {
    proxyData,
    proxyLoading,
    proxyError,
    coreStatus,
    coreError,
    connectivityData,
    connectivityLoading,
    connectivityError,
    gitInput,
    setGitInput,
    npmInput,
    setNpmInput,
    selectedSource,
    setSelectedSource,
    savingTarget,
    probeRoute,
    setProbeRoute,
    fetchProxy,
    testConnectivity,
    detectedSources,
    observation,
    reachableCount,
    saveProxy
  };
}
