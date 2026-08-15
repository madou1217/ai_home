import { Popconfirm, Space, Tag, Tooltip } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ForkOutlined,
  QrcodeOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { DedicatedPortsActiveServer, ProxyNode } from '@/types';

interface ProxyNodeCardProps {
  node: ProxyNode;
  activePort?: DedicatedPortsActiveServer;
  currentOutbound: boolean;
  dataPlaneReady: boolean;
  pinging: boolean;
  onPing: () => void;
  onTogglePort: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}

function LatencyBadge({ latency }: { latency: number | null | undefined }) {
  if (latency === undefined || latency === null) return <Tag>未实测</Tag>;
  if (latency < 0) return <Tag color="error">不可达</Tag>;
  if (latency < 180) return <Tag color="success">{latency} ms</Tag>;
  if (latency < 400) return <Tag color="warning">{latency} ms</Tag>;
  return <Tag color="error">{latency} ms</Tag>;
}

export default function ProxyNodeCard({
  node,
  activePort,
  currentOutbound,
  dataPlaneReady,
  pinging,
  onPing,
  onTogglePort,
  onEdit,
  onDelete,
  onShare
}: ProxyNodeCardProps) {
  return (
    <article
      className={`toolkit-app-card ${activePort ? 'installed' : ''}`}
      data-current-outbound={currentOutbound || undefined}
    >
      <div>
        <div className="toolkit-card-header">
          <div className="toolkit-card-title-group">
            <span aria-hidden className="proxy-country-flag">{node.countryFlag || '🌐'}</span>
            <div className="proxy-node-heading">
              <h3 className="toolkit-card-title" title={node.name}>{node.name}</h3>
              <Space size={4} wrap>
                <Tag color="blue">{node.protocol.toUpperCase()}</Tag>
                <LatencyBadge latency={node.latencyMs} />
                {currentOutbound && <Tag color="gold">当前出口</Tag>}
              </Space>
            </div>
          </div>
        </div>

        <div className="toolkit-card-body">
          <div className="toolkit-detail-row">
            <span className="toolkit-detail-label">服务器</span>
            <span className="toolkit-detail-value" title={`${node.server}:${node.port}`}>
              {node.server}:{node.port}
            </span>
          </div>
          {node.cipher && (
            <div className="toolkit-detail-row">
              <span className="toolkit-detail-label">加密</span>
              <span className="toolkit-detail-value">{node.cipher}</span>
            </div>
          )}
          {node.sni && (
            <div className="toolkit-detail-row">
              <span className="toolkit-detail-label">SNI</span>
              <span className="toolkit-detail-value" title={node.sni}>{node.sni}</span>
            </div>
          )}
          {activePort && (
            <div className="toolkit-detail-row">
              <span className="toolkit-detail-label">本地 mixed</span>
              <Tag color="green" className="proxy-local-port">127.0.0.1:{activePort.port}</Tag>
            </div>
          )}
        </div>
      </div>

      <div className="toolkit-card-actions">
        <Space size={6} wrap>
          <Tooltip title={dataPlaneReady ? '由 Mihomo 实测' : '代理核心未就绪'}>
            <Button
              size="small"
              loading={pinging}
              disabled={!dataPlaneReady}
              icon={<ThunderboltOutlined />}
              onClick={onPing}
            >
              实测
            </Button>
          </Tooltip>
          <Tooltip title={dataPlaneReady ? '同时接受 HTTP 与 SOCKS5 客户端' : '代理核心未就绪'}>
            <Button
              size="small"
              type={activePort ? 'default' : 'dashed'}
              disabled={!dataPlaneReady}
              icon={<ForkOutlined />}
              onClick={onTogglePort}
            >
              {activePort ? '关闭端口' : '独立端口'}
            </Button>
          </Tooltip>
          <Button
            size="small"
            icon={<QrcodeOutlined />}
            disabled={!node.rawUri}
            onClick={onShare}
          >
            分享
          </Button>
        </Space>
        <Space size={4}>
          <Button
            aria-label={`编辑节点 ${node.name}`}
            size="small"
            icon={<EditOutlined />}
            onClick={onEdit}
          />
          <Popconfirm
            title="删除此节点？"
            description="该操作也会移除其独立端口映射。"
            onConfirm={onDelete}
            okText="删除"
            cancelText="取消"
          >
            <Button
              aria-label={`删除节点 ${node.name}`}
              size="small"
              danger
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </Space>
      </div>
    </article>
  );
}
