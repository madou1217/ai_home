import { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Select, Space, Tag, Typography } from 'antd';
import { aggregatorErrorText, chainCandidateNodes, chainIssue, chainPath, responseErrorCode, skipReasonText } from './aggregator-presentation';
import type { AggregatorNodeOption } from './types';

const { Text } = Typography;

interface NodeChainModalProps {
  open: boolean;
  /** 正在配置的节点 */
  node: { id: string; name: string } | null;
  /** 全部节点（含手动节点），用来选前置 */
  nodes: AggregatorNodeOption[];
  /** 保存成功（返回 false 表示没成功，不关窗） */
  onSubmit: (chain: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * 给一个节点选「前置节点」：本节点的流量先经过前置再出去，前置自己还能有前置，
 * 于是形成 A → B → C 的多级链（内部链式代理）。
 *
 * 不能选自己，也不能选自己链上的下游 —— 那两种都会成环，这里直接不给选；
 * 服务端保存时还会再校验一遍。
 */
export default function NodeChainModal({ open, node, nodes, onSubmit, onClose }: NodeChainModalProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !node) return;
    setValue(String(nodes.find((item) => item.id === node.id)?.chain || ''));
    setError('');
  }, [node, nodes, open]);

  // 候选：排除自己与自己的下游（会成环）。
  const candidates = useMemo(() => (node ? chainCandidateNodes(node.id, nodes) : []), [node, nodes]);
  const options = useMemo(
    () => candidates.map((item) => ({ value: item.id, label: `${item.name}（${item.protocol}）` })),
    [candidates]
  );
  // 预览整条链：把待保存的前置套上去算，改动还没提交也能看到结果。
  const preview = useMemo(() => {
    if (!node) return [];
    const draft = nodes.map((item) => (item.id === node.id ? { ...item, chain: value } : item));
    return chainPath(node.id, draft);
  }, [node, nodes, value]);
  const issue = value ? chainIssue(node?.id || '', nodes.map((item) => (item.id === node?.id ? { ...item, chain: value } : item))) : '';

  const submit = async () => {
    if (!node) return;
    setSaving(true);
    setError('');
    try {
      if (await onSubmit(value)) onClose();
    } catch (submitError) {
      setError(aggregatorErrorText(responseErrorCode(submitError), '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={node ? `前置节点 · ${node.name}` : '前置节点'}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="保存"
      confirmLoading={saving}
      width={520}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">选一个节点作为前置：连它，再由它连到本节点。前置自己也能有前置，可以串成多级链。</Text>
        <Select
          value={value || undefined}
          onChange={(next) => setValue(String(next || ''))}
          options={options}
          placeholder="直连（不经过前置）"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          aria-label="前置节点"
        />
        {preview.length > 1 ? (
          <Space size={6} wrap>
            <Text type="secondary">链路</Text>
            {preview.map((item, index) => (
              <span key={item.id}>
                {index > 0 ? <Text type="secondary">→ </Text> : null}
                <Tag color={index === 0 ? 'blue' : 'default'}>{item.name}</Tag>
              </span>
            ))}
          </Space>
        ) : null}
        {issue ? <Alert type="warning" showIcon message={skipReasonText(issue)} /> : null}
        <Text type="secondary">
          注意：链式代理要用支持它的输出格式（mihomo / Clash 系、sing-box、Surge 系），其它格式会跳过配了前置的节点。
        </Text>
        {error ? <Text type="danger">{error}</Text> : null}
      </Space>
    </Modal>
  );
}
