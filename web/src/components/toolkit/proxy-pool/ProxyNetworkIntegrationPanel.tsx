import { useState } from 'react';
import { Alert, Card, Input, Select, Space, Tag, message } from 'antd';
import { GlobalOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type { NetworkLayerStatus, ProxyCoreStatus, ProxyTunConfig } from '@/types';
import { getErrorMessage } from './proxy-pool-utils';

interface ProxyNetworkIntegrationPanelProps {
  status: NetworkLayerStatus | null;
  core: ProxyCoreStatus | null;
  onRefresh: () => Promise<void>;
}

function routeLabel(status: NetworkLayerStatus | null) {
  if (!status) return '读取中';
  if (status.effectiveRoute === 'tun') return `TUN${status.tun.owner ? `（${status.tun.owner}）` : ''}`;
  if (status.effectiveRoute === 'system-proxy') return '系统代理';
  if (status.effectiveRoute === 'direct-unknown') return '未发现显式代理（可能被透明网络层捕获）';
  return '网络层未知';
}

function confirmText(action: string, details: string) {
  return window.confirm(`${action}\n\n${details}\n\n这会修改当前用户的网络配置，是否继续？`);
}

export default function ProxyNetworkIntegrationPanel({ status, core, onRefresh }: ProxyNetworkIntegrationPanelProps) {
  const [service, setService] = useState('Wi-Fi');
  const [tunStack, setTunStack] = useState<ProxyTunConfig['stack']>(core?.tun?.stack || 'mixed');
  const [pending, setPending] = useState<'proxy-enable' | 'proxy-disable' | 'tun-enable' | 'tun-disable' | null>(null);

  const externalTun = status?.tun.state === 'active' && status.tun.owner !== 'aih';
  const tunEnabled = core?.tun?.enabled === true;

  const applyPlan = async (kind: 'system-proxy' | 'tun', action: 'enable' | 'disable', details: string, pendingKey: typeof pending, extra: Record<string, unknown> = {}) => {
    if (pending) return;
    setPending(pendingKey);
    try {
      const planned = await proxyPoolAPI.planNetwork({ kind, action, ...extra });
      if (!planned.ok || !planned.plan) {
        message.warning(planned.message || planned.error || '网络配置计划未生成');
        return;
      }
      const accepted = confirmText(action === 'enable' ? '准备启用网络接管' : '准备停用网络接管', details);
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

  return (
    <Card
      className="toolkit-network-integration"
      title={(
        <Space>
          <SafetyCertificateOutlined />
          网络层接管
        </Space>
      )}
      extra={<Tag color={status?.effectiveRouteKnown ? 'green' : 'gold'}>{routeLabel(status)}</Tag>}
    >
      {externalTun && (
        <Alert
          type="warning"
          showIcon
          message={`检测到外部 TUN：${status?.tun.owner || '未知工具'}`}
          description="AIH 不会停止、修改或抢占现有代理工具。系统代理和 AIH TUN 接管按钮已保护性禁用。"
          style={{ marginBottom: 12 }}
        />
      )}
      {!status && <Alert type="info" showIcon message="正在读取系统代理、TUN 和路由状态" style={{ marginBottom: 12 }} />}
      {status && !status.effectiveRouteKnown && !externalTun && (
        <Alert
          type="info"
          showIcon
          message="当前没有可确认的显式代理路径"
          description="direct-unknown 只表示没有读到系统 HTTP/SOCKS 开关，不代表没有透明代理或 VPN。"
          style={{ marginBottom: 12 }}
        />
      )}

      <div className="toolkit-network-integration-grid">
        <div>
          <div className="toolkit-field-label">macOS 网络服务</div>
          <Input value={service} onChange={(event) => setService(event.target.value)} placeholder="例如 Wi-Fi" />
          <Space wrap style={{ marginTop: 8 }}>
            <Button
              type="primary"
              icon={<GlobalOutlined />}
              loading={pending === 'proxy-enable'}
              disabled={externalTun || !service.trim() || !core?.dataPlaneReady}
              onClick={() => void applyPlan(
                'system-proxy',
                'enable',
                `将把 HTTP/HTTPS/SOCKS 指向 ${core?.mixedProxyUrl || 'AIH mixed 端口'}，当前网络服务：${service}`,
                'proxy-enable',
                { service }
              )}
            >
              启用系统代理
            </Button>
            <Button
              loading={pending === 'proxy-disable'}
              disabled={externalTun || !service.trim()}
              onClick={() => void applyPlan(
                'system-proxy',
                'disable',
                `关闭 ${service} 的 HTTP/HTTPS/SOCKS/PAC 代理开关，不删除原配置快照。`,
                'proxy-disable',
                { service }
              )}
            >
              关闭系统代理
            </Button>
          </Space>
        </div>

        <div>
          <div className="toolkit-field-label">AIH TUN 模式</div>
          <Select
            value={tunStack}
            onChange={setTunStack}
            style={{ minWidth: 150 }}
            options={[
              { label: 'mixed（兼容）', value: 'mixed' },
              { label: 'gvisor（隔离）', value: 'gvisor' },
              { label: 'system（系统栈）', value: 'system' }
            ]}
          />
          <Space wrap style={{ marginTop: 8 }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={pending === 'tun-enable'}
              disabled={externalTun || tunEnabled || !core?.installed}
              onClick={() => void applyPlan(
                'tun',
                'enable',
                `启用 AIH Mihomo TUN（${tunStack}）。系统可能要求管理员权限；现有外部 TUN 不会被关闭。`,
                'tun-enable',
                { tun: { enabled: true, stack: tunStack } }
              )}
            >
              启用 AIH TUN
            </Button>
            <Button
              loading={pending === 'tun-disable'}
              disabled={externalTun || !tunEnabled}
              onClick={() => void applyPlan(
                'tun',
                'disable',
                '停用 AIH 自己的 TUN 配置并重载 Mihomo；不会操作外部代理工具。',
                'tun-disable'
              )}
            >
              停用 AIH TUN
            </Button>
          </Space>
        </div>
      </div>
    </Card>
  );
}
