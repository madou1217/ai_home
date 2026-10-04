import { useEffect, useState } from 'react';
import { Modal, Radio, Space, Tag, Typography } from 'antd';
import type { OutboundSuggestResponse } from '@/types';

const { Text } = Typography;

interface ProxyOutboundSuggestModalProps {
  suggestion: OutboundSuggestResponse | null;
  applying: boolean;
  onApply: (nodeId: string) => void;
  onClose: () => void;
}

/** 测速后的默认出口候选（按延迟升序）；默认选中最快的，确认后才写入分流配置。 */
export default function ProxyOutboundSuggestModal({ suggestion, applying, onApply, onClose }: ProxyOutboundSuggestModalProps) {
  const candidates = suggestion?.candidates || [];
  const [selected, setSelected] = useState('');

  useEffect(() => {
    setSelected(candidates[0]?.nodeId || '');
  }, [suggestion]);

  return (
    <Modal
      title="设置默认出口"
      open={Boolean(suggestion)}
      okText="设为默认出口"
      cancelText="取消"
      confirmLoading={applying}
      okButtonProps={{ disabled: !selected }}
      onOk={() => selected && onApply(selected)}
      onCancel={onClose}
      destroyOnClose
    >
      <Text type="secondary">
        已实测 {suggestion?.testedCount || 0} 个节点，{suggestion?.reachableCount || 0} 个可达。以下按延迟从低到高排列：
      </Text>
      <Radio.Group
        className="proxy-outbound-candidates"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
          {candidates.map((candidate, index) => (
            <Radio key={candidate.nodeId} value={candidate.nodeId}>
              <Space size={8} wrap>
                <span>{candidate.name}</span>
                <Tag color={index === 0 ? 'success' : 'default'}>{candidate.latencyMs} ms</Tag>
                {index === 0 ? <Tag color="processing">最快</Tag> : null}
              </Space>
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Modal>
  );
}
