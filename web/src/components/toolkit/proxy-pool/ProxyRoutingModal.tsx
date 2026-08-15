import { Alert, Divider, Modal, Radio, Select, Space, Tag, Typography, message } from 'antd';
import { proxyPoolAPI } from '@/services/api';
import type { ProxyNode, RoutingResponse } from '@/types';
import { getErrorMessage } from './proxy-pool-utils';

const { Text, Title } = Typography;

interface ProxyRoutingModalProps {
  open: boolean;
  dataPlaneReady: boolean;
  nodes: ProxyNode[];
  routingResponse: RoutingResponse | null;
  onClose: () => void;
  onChanged: (response: RoutingResponse) => void;
}

export default function ProxyRoutingModal({
  open,
  dataPlaneReady,
  nodes,
  routingResponse,
  onClose,
  onChanged
}: ProxyRoutingModalProps) {
  const routing = routingResponse?.routing;

  const update = async (mode: 'global' | 'rule' | 'direct', nodeId?: string) => {
    try {
      const result = await proxyPoolAPI.setRouting({ mode, activeOutboundNodeId: nodeId });
      onChanged(result);
      if (result.ok && result.applied) {
        message.success(`分流模式已在数据面生效：${mode.toUpperCase()}`);
      } else {
        message.warning(result.message || result.error || result.warnings?.join('；') || '配置已保存，但尚未应用到代理数据面');
      }
    } catch (error) {
      message.error(getErrorMessage(error, '分流配置未生效'));
    }
  };

  return (
    <Modal title="分流与默认出口" open={open} onCancel={onClose} footer={null} width={700}>
      {!dataPlaneReady && (
        <Alert
          type="warning"
          showIcon
          message="代理数据面未就绪"
          description="当前仅展示已保存配置；为避免误导，切换操作保持禁用。"
        />
      )}
      <Title level={5}>出站模式</Title>
      <Radio.Group
        value={routing?.mode || 'rule'}
        disabled={!dataPlaneReady}
        onChange={(event) => void update(event.target.value, routing?.activeOutboundNodeId || undefined)}
      >
        <Radio.Button value="rule">规则分流</Radio.Button>
        <Radio.Button value="global">全局代理</Radio.Button>
        <Radio.Button value="direct">全局直连</Radio.Button>
      </Radio.Group>
      <div className="proxy-routing-section">
        <Title level={5}>默认代理节点</Title>
        <Select
          aria-label="默认代理节点"
          style={{ width: '100%' }}
          disabled={!dataPlaneReady}
          value={routing?.activeOutboundNodeId || undefined}
          placeholder="选择规则或全局模式的默认出口"
          onChange={(value) => void update(routing?.mode || 'rule', value)}
          options={nodes.map((node) => ({ label: node.name, value: node.id }))}
        />
      </div>
      <Space wrap>
        <Tag color={routingResponse?.applied ? 'success' : 'warning'}>
          {routingResponse?.applied ? '已应用到数据面' : '仅配置态'}
        </Tag>
        {(routingResponse?.message || routingResponse?.error || routingResponse?.reason) && (
          <Text type="secondary">{routingResponse.message || routingResponse.error || routingResponse.reason}</Text>
        )}
      </Space>
      <Divider />
      <Title level={5}>当前规则</Title>
      <Space direction="vertical" style={{ width: '100%' }}>
        {(routing?.rules || []).map((rule) => (
          <div key={rule.id} className="toolkit-mirror-row">
            <div>
              <strong>{rule.name}</strong>
              <Tag color={rule.outbound === 'proxy' ? 'blue' : rule.outbound === 'reject' ? 'red' : 'green'}>
                {rule.outbound.toUpperCase()}
              </Tag>
              <div><Text type="secondary">{rule.domains?.slice(0, 4).join(', ') || rule.target}</Text></div>
            </div>
          </div>
        ))}
      </Space>
    </Modal>
  );
}
