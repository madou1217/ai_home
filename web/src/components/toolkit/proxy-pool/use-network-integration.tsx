import { useState } from 'react';
import { message } from 'antd';
import { confirmAction } from '@/utils/confirm-action';
import { proxyPoolAPI } from '@/services/api';
import type { NetworkLayerStatus, ProxyCoreStatus, ProxyTunConfig } from '@/types';
import { getErrorMessage } from './proxy-pool-utils';

export type NetworkIntegrationPending = 'proxy-enable' | 'proxy-disable' | 'tun-enable' | 'tun-disable';

export const TUN_STACK_OPTIONS: Array<{ label: string; value: NonNullable<ProxyTunConfig['stack']> }> = [
  { label: 'mixed（兼容）', value: 'mixed' },
  { label: 'gvisor（隔离）', value: 'gvisor' },
  { label: 'system（系统栈）', value: 'system' }
];

export function networkRouteLabel(status: NetworkLayerStatus | null) {
  if (!status) return '读取中';
  if (status.effectiveRoute === 'tun') return `TUN${status.tun.owner ? `（${status.tun.owner}）` : ''}`;
  if (status.effectiveRoute === 'system-proxy') return '系统代理';
  if (status.effectiveRoute === 'direct-unknown') return '未发现显式代理（可能被透明网络层捕获）';
  return '网络层未知';
}

function confirmText(action: string, details: string) {
  return confirmAction({
    title: action,
    content: (
      <div className="toolkit-confirm-detail">
        {`${details}\n\n这会修改当前用户的网络配置，是否继续？`}
      </div>
    ),
    danger: true,
  });
}

/**
 * 网络层接管（系统代理 / AIH TUN）的数据层（桌面面板与移动端共用）：
 * 先向服务端生成计划，再二次确认，最后按计划快照应用。
 */
export function useNetworkIntegration(core: ProxyCoreStatus | null, status: NetworkLayerStatus | null, onRefresh: () => Promise<void>) {
  const [service, setService] = useState('Wi-Fi');
  const [tunStack, setTunStack] = useState<ProxyTunConfig['stack']>(core?.tun?.stack || 'mixed');
  const [pending, setPending] = useState<NetworkIntegrationPending | null>(null);

  const externalTun = status?.tun.state === 'active' && status.tun.owner !== 'aih';
  const tunEnabled = core?.tun?.enabled === true;

  const applyPlan = async (kind: 'system-proxy' | 'tun', action: 'enable' | 'disable', details: string, pendingKey: NetworkIntegrationPending, extra: Record<string, unknown> = {}) => {
    if (pending) return;
    setPending(pendingKey);
    try {
      const planned = await proxyPoolAPI.planNetwork({ kind, action, ...extra });
      if (!planned.ok || !planned.plan) {
        message.warning(planned.message || planned.error || '网络配置计划未生成');
        return;
      }
      const accepted = await confirmText(action === 'enable' ? '准备启用网络接管' : '准备停用网络接管', details);
      if (!accepted) return;
      const applied = await proxyPoolAPI.applyNetwork(planned.plan.planId, planned.plan.snapshotHash, true);
      if (!applied.ok || applied.applied !== true) {
        message.error(applied.message || applied.error || '网络配置未应用');
        return;
      }
      message.success(kind === 'tun' ? 'AIH TUN 配置已应用' : '系统代理配置已应用');
      await onRefresh();
    } catch (error) {
      message.error(getErrorMessage(error, '网络配置操作失败'));
    } finally {
      setPending(null);
    }
  };

  const enableSystemProxy = () => applyPlan(
    'system-proxy',
    'enable',
    `将把 HTTP/HTTPS/SOCKS 指向 ${core?.mixedProxyUrl || 'AIH mixed 端口'}，当前网络服务：${service}`,
    'proxy-enable',
    { service }
  );
  const disableSystemProxy = () => applyPlan(
    'system-proxy',
    'disable',
    `关闭 ${service} 的 HTTP/HTTPS/SOCKS/PAC 代理开关，不删除原配置快照。`,
    'proxy-disable',
    { service }
  );
  const enableTun = () => applyPlan(
    'tun',
    'enable',
    `启用 AIH Mihomo TUN（${tunStack}）。系统可能要求管理员权限；现有外部 TUN 不会被关闭。`,
    'tun-enable',
    { tun: { enabled: true, stack: tunStack } }
  );
  const disableTun = () => applyPlan(
    'tun',
    'disable',
    '停用 AIH 自己的 TUN 配置并重载 Mihomo；不会操作外部代理工具。',
    'tun-disable'
  );

  return {
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
  };
}
