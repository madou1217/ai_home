import { Tag } from 'antd';
import type { ProxyStatusResponse } from '@/types';

const ROUTE_LABELS: Record<string, string> = {
  tun: 'TUN',
  'system-proxy': '系统代理',
  'direct-unknown': '直连（未探测到代理）',
  unknown: '未知'
};

const TUN_LABELS: Record<string, string> = {
  active: 'TUN 已启用',
  inactive: 'TUN 未启用',
  unknown: 'TUN 未知'
};

function firstProxy(...values: Array<string | undefined | null>) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

export default function ProviderNetworkLayers({ proxyStatus }: { proxyStatus: ProxyStatusResponse | null }) {
  return (
    <section className="pn-layers" aria-label="代理层">
      <div className="pn-layer-head">
        <strong>代理层</strong>
        <span>网络层与系统层由操作系统/代理客户端决定；应用层按 Provider 与账号选择。AIH 只做只读诊断，不会接管外部代理内核。</span>
      </div>
      <div className="pn-layer-grid">
        <div className="pn-layer">
          <span className="pn-layer-name">网络层</span>
          <span className="pn-layer-value">
            <Tag bordered={false} color={proxyStatus?.layer?.tun.state === 'active' ? 'success' : 'default'}>
              {TUN_LABELS[proxyStatus?.layer?.tun.state || ''] || 'TUN 未知'}
            </Tag>
            <span>{ROUTE_LABELS[proxyStatus?.layer?.effectiveRoute || ''] || proxyStatus?.layer?.effectiveRoute || '未知'}</span>
          </span>
          <small>
            {proxyStatus?.layer?.tun.owner
              ? `归属 ${proxyStatus.layer.tun.owner}`
              : proxyStatus?.layer?.tun.interfaceDetected ? '检测到虚拟网卡' : '未检测到虚拟网卡'}
          </small>
        </div>
        <div className="pn-layer">
          <span className="pn-layer-name">系统层</span>
          <span className="pn-layer-value">
            <Tag bordered={false} color={proxyStatus?.system?.enabled ? 'success' : 'default'}>
              {proxyStatus?.system?.enabled ? '系统代理已启用' : '系统代理未启用'}
            </Tag>
          </span>
          <small>
            {firstProxy(proxyStatus?.system?.httpsProxy, proxyStatus?.system?.httpProxy, proxyStatus?.system?.socksProxy) || '无系统代理'}
          </small>
          <small>
            环境代理：{firstProxy(proxyStatus?.env?.httpsProxy, proxyStatus?.env?.httpProxy, proxyStatus?.env?.allProxy) || '未设置'}
          </small>
        </div>
        <div className="pn-layer">
          <span className="pn-layer-name">工具层</span>
          <small>Git：{firstProxy(proxyStatus?.tools?.git?.httpsProxy, proxyStatus?.tools?.git?.httpProxy) || '未设置'}</small>
          <small>npm：{firstProxy(proxyStatus?.tools?.npm?.httpsProxy, proxyStatus?.tools?.npm?.httpProxy) || '未设置'}</small>
        </div>
        <div className="pn-layer">
          <span className="pn-layer-name">网关层</span>
          <small>{proxyStatus?.gateway?.proxyUrl ? `上游代理 ${proxyStatus.gateway.proxyUrl}` : '未设置（直连/系统网络）'}</small>
          <small>no_proxy：{proxyStatus?.gateway?.noProxy || '未设置'}</small>
        </div>
        <div className="pn-layer">
          <span className="pn-layer-name">应用层</span>
          <small>下方账号出口；未绑定时跟随 OAuth 授权网络。</small>
        </div>
      </div>
    </section>
  );
}
