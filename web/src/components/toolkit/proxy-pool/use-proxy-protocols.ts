import { useEffect, useMemo, useState } from 'react';
import { proxyPoolAPI } from '@/services/api';
import type { ProxyProtocolPlugin } from '@/types';
import {
  FALLBACK_PROXY_PROTOCOLS,
  protocolFilterOptions,
  protocolSelectOptions
} from './proxy-protocol-schema';

let protocolsRequest: Promise<ProxyProtocolPlugin[]> | null = null;

function loadProxyProtocols() {
  if (!protocolsRequest) {
    protocolsRequest = proxyPoolAPI.getProtocols()
      .then((response) => (response.ok && response.protocols?.length ? response.protocols : FALLBACK_PROXY_PROTOCOLS))
      .catch(() => {
        protocolsRequest = null;
        return FALLBACK_PROXY_PROTOCOLS;
      });
  }
  return protocolsRequest;
}

/** 代理协议插件清单（桌面面板、移动端与节点编辑弹窗共用；一次会话只请求一次）。 */
export function useProxyProtocols() {
  const [plugins, setPlugins] = useState<ProxyProtocolPlugin[]>(FALLBACK_PROXY_PROTOCOLS);
  useEffect(() => {
    let active = true;
    void loadProxyProtocols().then((loaded) => {
      if (active) setPlugins(loaded);
    });
    return () => { active = false; };
  }, []);
  return useMemo(() => ({
    plugins,
    selectOptions: protocolSelectOptions(plugins),
    filterOptions: protocolFilterOptions(plugins)
  }), [plugins]);
}
