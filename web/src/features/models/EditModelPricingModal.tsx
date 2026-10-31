import { useEffect } from 'react';
import { Form, InputNumber, Modal, Typography } from 'antd';
import type { CustomPricing, Provider } from '@/types';
import { buildCustomPricingPayload } from './edit-model-pricing';

export interface EditModelPricingModalProps {
  open: boolean;
  /** 目标模型（编辑中）；null = 关闭。 */
  target: {
    id: string;
    accountRef: string;
    provider: Provider;
    customPricing?: CustomPricing;
  } | null;
  submitting?: boolean;
  onDismiss: () => void;
  /** 提交。undefined = 不修改该维度；null = 清空；数值 = 每百万 token 美元。 */
  onSubmit: (payload: {
    id: string;
    accountRef: string;
    provider: Provider;
    customPricing: CustomPricing | null;
  }) => Promise<void>;
}

export { buildCustomPricingPayload };

const FIELDS = [
  { name: 'input', label: '输入价（$/M）', placeholder: '留空保持原价，填 0 表示免费' },
  { name: 'output', label: '输出价（$/M）', placeholder: '留空保持原价，填 0 表示免费' },
  { name: 'cacheRead', label: '缓存读取价（$/M）', placeholder: '留空保持原价' },
  { name: 'cacheWrite', label: '缓存写入价（$/M）', placeholder: '留空保持原价' },
] as const;

const EMPTY_VALUES = { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined };

/**
 * 编辑模型价格弹窗（受控组件：状态留在页面，行为通过 props + 回调）。
 * 空字段 = 保持原价（undefined，不提交该维度）；0 = 免费价（有效值，会提交）。
 * 「恢复原价」= 提交 null，服务端清空 customPricing。
 */
export function EditModelPricingModal({ open, target, submitting = false, onDismiss, onSubmit }: EditModelPricingModalProps) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open || !target) return;
    const current = target.customPricing || EMPTY_VALUES;
    form.setFieldsValue({
      input: current.input,
      output: current.output,
      cacheRead: current.cacheRead,
      cacheWrite: current.cacheWrite
    });
  }, [open, target, form]);

  const hasExistingCustom = Boolean(target && target.customPricing && Object.keys(target.customPricing).length > 0);

  async function handleSubmit() {
    if (!target) return;
    const values = await form.validateFields();
    await onSubmit({ id: target.id, accountRef: target.accountRef, provider: target.provider, customPricing: buildCustomPricingPayload(values) });
  }

  return (
    <Modal
      open={open}
      title="编辑模型价格"
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      onOk={() => { void handleSubmit(); }}
      onCancel={onDismiss}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        仅覆盖本账号用量统计与展示口径，单位=美元/每百万 token；空字段保持 models.dev 原价。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" disabled={!target}>
        {FIELDS.map((field) => (
          <Form.Item key={field.name} name={field.name} label={field.label}>
            <InputNumber
              min={0}
              step="0.01"
              style={{ width: '100%' }}
              placeholder={field.placeholder}
            />
          </Form.Item>
        ))}
      </Form>
      {hasExistingCustom ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          该模型存在自定义价，清空所有字段并保存可恢复 models.dev 原价。
        </Typography.Text>
      ) : null}
    </Modal>
  );
}

export default EditModelPricingModal;
