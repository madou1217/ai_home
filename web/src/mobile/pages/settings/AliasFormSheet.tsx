import { SaveOutlined } from '@ant-design/icons';
import { Form, Input, InputNumber, Select, Switch } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  ALIAS_PROVIDER_SELECT_OPTIONS,
  MODEL_ALIAS_FIELD_HELP,
  MODEL_ALIAS_FIELD_RULES,
  MODEL_ALIAS_FORM_DEFAULTS,
  buildTargetModelGroups,
  expandAliasSelections,
  getAliasProviderDisplayName
} from '@/features/model-aliases/model-alias-presentation';
import { DetailSheet, HudIconButton } from '@/mobile/ui';
import type { ModelAlias } from '@/services/api';
import styles from './MobileSettings.module.css';

interface Props {
  open: boolean;
  /** 编辑的别名；null 为新增 */
  editing: ModelAlias | null;
  modelsByProvider: Record<string, string[]>;
  modelsLoading: boolean;
  getModelLabel: (provider: string, model: string) => string;
  onClose: () => void;
  onSave: (editingId: string | null, values: Partial<ModelAlias>) => Promise<boolean>;
}

/** 新增 / 编辑模型别名：字段、校验、说明与桌面 ModalForm 一致，提交走 modelAliasesAPI.create / update。 */
export default function AliasFormSheet({
  open,
  editing,
  modelsByProvider,
  modelsLoading,
  getModelLabel,
  onClose,
  onSave
}: Props) {
  const [form] = Form.useForm<Partial<ModelAlias>>();
  const [saving, setSaving] = useState(false);
  const targetProvider = (Form.useWatch('targetProvider', form) as string | undefined) || 'auto';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({ ...editing, targetProvider: editing.targetProvider || 'auto' });
    }
  }, [editing, form, open]);

  const targetOptions = useMemo(() => buildTargetModelGroups(modelsByProvider, targetProvider).map((group) => ({
    label: getAliasProviderDisplayName(group.provider),
    options: group.models.map((model) => {
      const label = getModelLabel(group.provider, model);
      return { key: `${group.provider}:${model}`, value: model, label: label ? `${model} — ${label}` : model };
    })
  })), [getModelLabel, modelsByProvider, targetProvider]);

  const submit = async () => {
    let values: Partial<ModelAlias>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      // 多选展开成逐条记录（笛卡尔积，只保留目录里真实存在的组合）。
      const records = expandAliasSelections(values, modelsByProvider);
      if (await onSave(editing?.id || null, { ...values, records })) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="ALIAS"
      title={editing ? '编辑模型别名' : '添加模型别名'}
      destroyOnClose={false}
      footer={(
        <>
          <HudIconButton icon={null} label="取消" showLabel onClick={onClose} />
          <HudIconButton icon={<SaveOutlined />} label="保存" tone="primary" showLabel loading={saving} onClick={submit} />
        </>
      )}
    >
      <Form form={form} layout="vertical" className={styles.form} initialValues={MODEL_ALIAS_FORM_DEFAULTS}>
        <Form.Item name="alias" label="别名 (Alias)" rules={MODEL_ALIAS_FIELD_RULES.alias} help={MODEL_ALIAS_FIELD_HELP.alias}>
          <Input
            placeholder="输入别名或尾部通配符"
            className={styles.monoInput}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Form.Item>
        <Form.Item name="target" label="目标模型 (Target)" rules={MODEL_ALIAS_FIELD_RULES.target} help={MODEL_ALIAS_FIELD_HELP.target}>
          <Select
            mode="multiple"
            showSearch
            loading={modelsLoading}
            placeholder="可多选：选中项按供应商展开成多条记录"
            optionFilterProp="label"
            disabled={targetOptions.length === 0}
            options={targetOptions}
            maxTagCount="responsive"
          />
        </Form.Item>
        <Form.Item name="provider" label="请求范围 (Provider Scope)" rules={MODEL_ALIAS_FIELD_RULES.provider} help={MODEL_ALIAS_FIELD_HELP.provider}>
          <Select options={[{ value: 'all', label: '全部 (All)' }, ...ALIAS_PROVIDER_SELECT_OPTIONS]} />
        </Form.Item>
        <Form.Item
          name="targetProvider"
          label="目标供应商 (Target Provider)"
          rules={MODEL_ALIAS_FIELD_RULES.targetProvider}
          help={MODEL_ALIAS_FIELD_HELP.targetProvider}
        >
          <Select
            mode="multiple"
            maxTagCount="responsive"
            options={[{ value: 'auto', label: '自动 (Auto)' }, ...ALIAS_PROVIDER_SELECT_OPTIONS]}
            onChange={() => {
              // 供应商集合变化后清掉不在所选目录里的模型，避免留下必然失败的组合。
              const nextProviders = form.getFieldValue('targetProvider');
              const selected = form.getFieldValue('target');
              if (!Array.isArray(selected) || selected.length === 0) return;
              const groups = buildTargetModelGroups(modelsByProvider, nextProviders);
              const allowed = new Set(groups.flatMap((group) => group.models));
              const kept = selected.filter((model: string) => allowed.has(model));
              if (kept.length !== selected.length) form.setFieldValue('target', kept);
            }}
          />
        </Form.Item>
        <Form.Item name="priority" label="优先级 (Priority)" help={MODEL_ALIAS_FIELD_HELP.priority}>
          <InputNumber precision={0} placeholder="默认 0" inputMode="numeric" />
        </Form.Item>
        <Form.Item name="description" label="备注">
          <Input.TextArea placeholder="可选备注信息" autoSize={{ minRows: 2, maxRows: 5 }} />
        </Form.Item>
        <Form.Item name="enabled" label="状态" valuePropName="checked">
          <Switch checkedChildren="启用" unCheckedChildren="禁用" />
        </Form.Item>
      </Form>
    </DetailSheet>
  );
}
