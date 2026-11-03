import { useEffect, useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Form, Input, Switch } from 'antd';
import { DetailSheet, HudIconButton, KeyValue } from '@/mobile/ui';
import type { AccountManualModelValues } from '@/features/models/use-account-models';
import styles from '../MobileAccountModels.module.css';

interface Props {
  open: boolean;
  providerLabel: string;
  accountLabel: string;
  onClose: () => void;
  onSubmit: (values: AccountManualModelValues) => Promise<boolean>;
}

/**
 * 手动添加模型（账号作用域）：Provider / 账号固定为当前账号（桌面同场景两项下拉禁用），
 * 字段与校验同桌面「手动添加模型」：模型 ID 必填、备注可选、默认启用。
 */
export default function AccountManualModelSheet({ open, providerLabel, accountLabel, onClose, onSubmit }: Props) {
  const [form] = Form.useForm<AccountManualModelValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) form.setFieldsValue({ id: '', description: '', enabled: true });
  }, [form, open]);

  const submit = async () => {
    let values: AccountManualModelValues;
    try {
      values = await form.validateFields();
    } catch (_error) {
      return;
    }
    setSubmitting(true);
    try {
      const ok = await onSubmit(values);
      if (ok) {
        form.resetFields();
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="MANUAL"
      title="手动添加模型"
      footer={(
        <div className={styles.sheetFooter}>
          <HudIconButton icon={<PlusOutlined />} label="添加" tone="primary" showLabel loading={submitting} onClick={submit} />
        </div>
      )}
    >
      <KeyValue
        rows={[
          { key: 'provider', label: 'Provider', value: providerLabel, mono: false },
          { key: 'account', label: '账号', value: accountLabel }
        ]}
      />
      <Form form={form} layout="vertical" className={styles.manualForm} initialValues={{ enabled: true }}>
        <Form.Item name="id" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID' }]}>
          <Input placeholder="例如 gpt-5.6-sol-wm 或 provider-custom-model" className={styles.monoInput} autoComplete="off" />
        </Form.Item>
        <Form.Item name="description" label="备注">
          <Input placeholder="可选，用于区分手动补充来源" />
        </Form.Item>
        <Form.Item name="enabled" label="默认启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </DetailSheet>
  );
}
