import { Descriptions, Empty, Space, Tag, Typography } from 'antd';
import type { AccountEgressRuntimeView } from '@/types';

interface Props { runtime: AccountEgressRuntimeView | null; loading?: boolean }

function value(input: unknown, fallback = '暂无') {
  const text = String(input ?? '').trim();
  return text || fallback;
}

export default function AccountEgressRuntimePanel({ runtime, loading = false }: Props) {
  if (loading) return <Typography.Text type="secondary">正在读取账号出口运行态…</Typography.Text>;
  if (!runtime) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号出口运行态" />;
  return (
    <div className="egress-runtime-panel hud-panel hud-panel--sm" data-testid="account-egress-runtime-panel">
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text strong>账号出口运行态</Typography.Text>
        <Descriptions size="small" column={2} colon={false}>
          <Descriptions.Item label="池组">{value(runtime.assignment?.poolGroupId)}</Descriptions.Item>
          <Descriptions.Item label="池">{value(runtime.assignment?.poolId)}</Descriptions.Item>
          <Descriptions.Item label="策略">{value(runtime.assignment?.strategy)}</Descriptions.Item>
          <Descriptions.Item label="选择模式">{value(runtime.assignment?.selectionMode)}</Descriptions.Item>
          <Descriptions.Item label="NodeEntity">{value(runtime.nodeId)}</Descriptions.Item>
          <Descriptions.Item label="运行节点">{value(runtime.runtimeName)}</Descriptions.Item>
          <Descriptions.Item label="出口地址">{value(runtime.proxyUrl)}</Descriptions.Item>
          <Descriptions.Item label="出口 IP">{value(runtime.exitIp)}</Descriptions.Item>
          <Descriptions.Item label="作用域判定">
            <Tag color={runtime.verdict?.status === 'denied' ? 'error' : runtime.verdict?.status === 'allowed' ? 'success' : 'default'}>
              {value(runtime.verdict?.status, '暂无判定')}
            </Tag>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </div>
  );
}
