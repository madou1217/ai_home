import { Card, Input, Select, Space, Tag } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import { GlobalOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { NetworkLayerStatus, ProxyCoreStatus } from '@/types';
import {
  networkRouteLabel as routeLabel,
  TUN_STACK_OPTIONS,
  useNetworkIntegration
} from './use-network-integration';

interface ProxyNetworkIntegrationPanelProps {
  status: NetworkLayerStatus | null;
  core: ProxyCoreStatus | null;
  onRefresh: () => Promise<void>;
}

export default function ProxyNetworkIntegrationPanel({ status, core, onRefresh }: ProxyNetworkIntegrationPanelProps) {
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
    <Card
      className="toolkit-network-integration hud-panel hud-panel--sm"
      title={(
        <Space>
          <SafetyCertificateOutlined />
          网络层接管
        </Space>
      )}
      extra={<Tag color={status?.effectiveRouteKnown ? 'green' : 'gold'}>{routeLabel(status)}</Tag>}
    >
      {externalTun && (
        <InlineNote
          tone="warning"
          description="AIH 不会停止、修改或抢占现有代理工具。系统代理和 AIH TUN 接管按钮已保护性禁用。"
          className="toolkit-note-spaced"
        >
          {`检测到外部 TUN：${status?.tun.owner || '未知工具'}`}
        </InlineNote>
      )}
      {!status && <InlineNote tone="info" className="toolkit-note-spaced">正在读取系统代理、TUN 和路由状态</InlineNote>}
      {status && !status.effectiveRouteKnown && !externalTun && (
        <InlineNote
          tone="info"
          description="direct-unknown 只表示没有读到系统 HTTP/SOCKS 开关，不代表没有透明代理或 VPN。"
          className="toolkit-note-spaced"
        >
          当前没有可确认的显式代理路径
        </InlineNote>
      )}

      <div className="toolkit-network-integration-grid">
        <div>
          <div className="toolkit-field-label">macOS 网络服务</div>
          <Input value={service} onChange={(event) => setService(event.target.value)} placeholder="例如 Wi-Fi" />
          <Space wrap>
            <Button
              type="primary"
              icon={<GlobalOutlined />}
              loading={pending === 'proxy-enable'}
              disabled={externalTun || !service.trim() || !core?.dataPlaneReady}
              onClick={() => void enableSystemProxy()}
            >
              启用系统代理
            </Button>
            <Button
              loading={pending === 'proxy-disable'}
              disabled={externalTun || !service.trim()}
              onClick={() => void disableSystemProxy()}
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
            options={TUN_STACK_OPTIONS}
          />
          <Space wrap>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={pending === 'tun-enable'}
              disabled={externalTun || tunEnabled || !core?.installed}
              onClick={() => void enableTun()}
            >
              启用 AIH TUN
            </Button>
            <Button
              loading={pending === 'tun-disable'}
              disabled={externalTun || !tunEnabled}
              onClick={() => void disableTun()}
            >
              停用 AIH TUN
            </Button>
          </Space>
        </div>
      </div>
    </Card>
  );
}
