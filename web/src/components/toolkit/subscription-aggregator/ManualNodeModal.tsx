import { useEffect, useMemo, useState } from 'react';
import { Form, Input, Modal, Select, Space, Typography } from 'antd';
import { RadarChartOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { aggregatorErrorText, responseErrorCode, skipReasonText } from './aggregator-presentation';
import { compactNode, prefillFromProbe, serializeManualNodes, type ManualNode } from './manual-nodes';
import ProbePanel from './ProbePanel';
import ProtocolNodeForm from './ProtocolNodeForm';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorProtocolForm } from './types';

const { Text } = Typography;

const DEFAULT_PROTOCOL = 'vless';

interface ManualNodeModalProps {
  open: boolean;
  title: string;
  forms: AggregatorProtocolForm[];
  /** 编辑已有节点时传入；新增为 null */
  initial: ManualNode | null;
  width?: number | string;
  onClose: () => void;
  onSubmit: (node: ManualNode) => Promise<boolean>;
}

/**
 * 手动填写节点：选协议后按服务端的表单描述填写；可以粘贴分享链接自动填表，或探测地址猜协议后填表。
 * 保存前用服务端解析校验一遍（与导入走同一套规则）。
 */
export default function ManualNodeModal({ open, title, forms, initial, width = 720, onClose, onSubmit }: ManualNodeModalProps) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [protocol, setProtocol] = useState(DEFAULT_PROTOCOL);
  const [link, setLink] = useState('');
  const [showProbe, setShowProbe] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // 每次填表（打开、粘贴链接、探测结果）都重新挂载字段，让有值的分区按填入的值展开。
  const [filled, setFilled] = useState<{ version: number; values: Record<string, unknown> }>({ version: 0, values: {} });
  const current = useMemo(() => forms.find((item) => item.protocol === protocol) || forms[0], [forms, protocol]);
  // 字段随协议变化，表单值只能是宽松的键值对。
  const setValues = (next: Record<string, unknown>) => form.setFieldsValue(next as Parameters<typeof form.setFieldsValue>[0]);

  const fill = (node: Record<string, unknown>) => {
    const next = forms.some((item) => item.protocol === node.protocol) ? String(node.protocol) : DEFAULT_PROTOCOL;
    setProtocol(next);
    const values = { ...(forms.find((item) => item.protocol === next)?.defaults || {}), ...node };
    form.resetFields();
    setValues(values);
    setFilled((current) => ({ version: current.version + 1, values }));
  };

  useEffect(() => {
    if (!open) return;
    setLink('');
    setShowProbe(false);
    setError('');
    fill(initial || { protocol: DEFAULT_PROTOCOL, port: 443 });
    // 只在打开时按初始值填一次（fill 每次渲染都是新函数，不能放进依赖）。
  }, [open, initial]);

  const fillFromLink = async () => {
    if (!link.trim()) return;
    setError('');
    try {
      const parsed = await subscriptionAggregatorAPI.parseNodes(link.trim());
      if (!parsed.nodes.length) {
        setError(parsed.skippedNodes[0] ? `没法用：${skipReasonText(parsed.skippedNodes[0].reason)}` : '没有识别出节点');
        return;
      }
      fill(parsed.nodes[0]);
      setLink('');
    } catch (parseError) {
      setError(aggregatorErrorText(responseErrorCode(parseError), '解析失败'));
    }
  };

  const submit = async () => {
    try {
      const raw = await form.validateFields();
      const keys = ['name', 'server', 'port', ...current.fields.map((field) => field.key)];
      const node = compactNode({ protocol, ...Object.fromEntries(keys.map((key) => [key, raw[key]])) }) as ManualNode;
      setSaving(true);
      setError('');
      // 与导入同一套校验：解析不出来的写法在这里就报出原因，不会保存一个用不了的节点。
      const check = await subscriptionAggregatorAPI.previewSource(serializeManualNodes([node]));
      if (check.skippedNodes.length) {
        setError(`保存不了：${skipReasonText(check.skippedNodes[0].reason)}`);
        return;
      }
      if (await onSubmit(node)) onClose();
    } catch (submitError) {
      if ((submitError as { errorFields?: unknown })?.errorFields) return;
      setError(aggregatorErrorText(responseErrorCode(submitError), '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} open={open} onCancel={onClose} onOk={() => void submit()} okText="保存" confirmLoading={saving} width={width} destroyOnHidden>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onPressEnter={() => void fillFromLink()}
            placeholder="粘贴分享链接（vless:// trojan:// ss:// …），自动填表"
            aria-label="粘贴分享链接"
          />
          <Button onClick={() => void fillFromLink()}>填表</Button>
        </Space.Compact>
        <Button type="dashed" icon={<RadarChartOutlined />} onClick={() => setShowProbe((value) => !value)}>
          {showProbe ? '收起探测' : '只知道地址？探测协议'}
        </Button>
        {showProbe ? (
          <ProbePanel
            onUse={(result, port, candidate) => {
              fill(prefillFromProbe(result, port, candidate));
              setShowProbe(false);
            }}
          />
        ) : null}
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="协议">
            <Select
              value={protocol}
              onChange={(next) => {
                setProtocol(next);
                const defaults = forms.find((item) => item.protocol === next)?.defaults || {};
                setValues(Object.fromEntries(Object.entries(defaults).filter(([key]) => form.getFieldValue(key) === undefined)));
              }}
              options={forms.map((item) => ({ value: item.protocol, label: `${item.name}（${item.protocol}）` }))}
              showSearch
              optionFilterProp="label"
              aria-label="节点协议"
            />
          </Form.Item>
          {current ? <ProtocolNodeForm key={`${protocol}:${filled.version}`} form={current} values={filled.values} /> : null}
        </Form>
        {error ? <Text type="danger">{error}</Text> : null}
      </Space>
    </Modal>
  );
}
