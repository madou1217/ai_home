import { PlusOutlined } from '@ant-design/icons';
import { Form, Input, Select, Switch } from 'antd';
import { useEffect, useState } from 'react';
import {
  DEFAULT_MANUAL_MODEL_PROVIDER,
  getAccountLabel,
  resolveManualModelAccountForProvider,
  type buildManualProviderOptions
} from '@/features/models/model-catalog';
import type { ManualModelValues } from '@/features/models/use-model-catalog-page';
import { DetailSheet, HudIconButton } from '@/mobile/ui';
import type { Provider, WebUiOpenAIModelAccount } from '@/types';
import styles from './MobileModels.module.css';

interface Props {
  open: boolean;
  /** 打开时写入的默认值（来自 getManualModelDefaults） */
  defaults: ManualModelValues | null;
  accountOptions: WebUiOpenAIModelAccount[];
  accountByRef: Map<string, WebUiOpenAIModelAccount>;
  providerOptions: ReturnType<typeof buildManualProviderOptions>;
  onClose: () => void;
  onSubmit: (values: ManualModelValues) => Promise<boolean>;
}

/** 手动添加模型：字段与校验规则同桌面「手动添加模型」弹窗，提交走 modelsAPI.createManualModel。 */
export default function ManualModelSheet({ open, defaults, accountOptions, accountByRef, providerOptions, onClose, onSubmit }: Props) {
  const [form] = Form.useForm<ManualModelValues>();
  const [submitting, setSubmitting] = useState(false);
  const provider = (Form.useWatch('provider', form) as Provider | undefined) || DEFAULT_MANUAL_MODEL_PROVIDER;

  useEffect(() => {
    if (!open || !defaults) return;
    form.resetFields();
    form.setFieldsValue(defaults);
  }, [defaults, form, open]);

  // Provider 切换后，账号不属于该 Provider 时改选该 Provider 的第一个账号
  useEffect(() => {
    if (!open) return;
    const next = resolveManualModelAccountForProvider(
      accountOptions,
      accountByRef,
      provider,
      String(form.getFieldValue('accountRef') || '')
    );
    if (next.changed) form.setFieldsValue({ accountRef: next.accountRef });
  }, [accountByRef, accountOptions, form, open, provider]);

  const accountSelectOptions = accountOptions
    .filter((account) => account.provider === provider)
    .map((account) => ({ label: getAccountLabel(account), value: account.accountRef }));

  const submit = async () => {
    let values: ManualModelValues;
    try {
      values = await form.validateFields();
    } catch {
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
      destroyOnClose={false}
      footer={(
        <>
          <HudIconButton icon={null} label="取消" showLabel onClick={onClose} />
          <HudIconButton icon={<PlusOutlined />} label="添加" tone="primary" showLabel loading={submitting} onClick={submit} />
        </>
      )}
    >
      <Form form={form} layout="vertical" className={styles.form} initialValues={{ provider: DEFAULT_MANUAL_MODEL_PROVIDER, enabled: true }}>
        <Form.Item name="provider" label="Provider" rules={[{ required: true, message: '请选择 Provider' }]}>
          <Select options={providerOptions} />
        </Form.Item>
        <Form.Item name="accountRef" label="账号" rules={[{ required: true, message: '请选择账号' }]}>
          <Select options={accountSelectOptions} placeholder="选择账号" />
        </Form.Item>
        <Form.Item name="id" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID' }]}>
          <Input
            placeholder="例如 gpt-5.6-sol-wm 或 provider-custom-model"
            className={styles.monoInput}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
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
