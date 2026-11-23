import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingSection from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import ListTable from '@/components/ui/ListTable';
import {
  ALIAS_PROVIDER_SELECT_OPTIONS as PROVIDER_SELECT_OPTIONS,
  MODEL_ALIAS_FIELD_HELP,
  MODEL_ALIAS_FIELD_RULES,
  MODEL_ALIAS_FORM_DEFAULTS,
  buildTargetModelGroups,
  expandAliasSelections,
  formatAliasScope,
  formatAliasTargetProvider,
  getAliasProviderDisplayName,
  groupModelAliases,
  type AliasGroup
} from '@/features/model-aliases/model-alias-presentation';
import { useModelAliases } from '@/features/model-aliases/use-model-aliases';
import '@/components/settings/gateway-settings.css';
import './ModelAliases.css';

interface AliasFormValues {
  alias: string;
  target: string[];
  provider: string;
  targetProvider: string[];
  priority: number;
  enabled: boolean;
  description: string;
}

interface InlineFeedback {
  tone: 'success' | 'error';
  text: string;
}

function normalizeStringList(values: unknown): string[] {
  const list = Array.isArray(values)
    ? values
    : (typeof values === 'string' && values ? [values] : []);
  return Array.from(new Set(list.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

function normalizeAliasForm(values: Partial<AliasFormValues> | undefined): AliasFormValues {
  const targetProvider = normalizeStringList(values?.targetProvider);
  return {
    alias: String(values?.alias || '').trim(),
    target: normalizeStringList(values?.target),
    provider: String(values?.provider || 'all'),
    targetProvider: targetProvider.length > 0 ? targetProvider : ['auto'],
    priority: Number(values?.priority || 0),
    enabled: values?.enabled !== false,
    description: String(values?.description || '').trim()
  };
}

function aliasFormsEqual(left: AliasFormValues, right: AliasFormValues) {
  return left.alias === right.alias
    && left.provider === right.provider
    && left.priority === right.priority
    && left.enabled === right.enabled
    && left.description === right.description
    && left.target.length === right.target.length
    && left.target.every((item, index) => item === right.target[index])
    && left.targetProvider.length === right.targetProvider.length
    && left.targetProvider.every((item, index) => item === right.targetProvider[index]);
}

function buildGroupFormValues(group: AliasGroup): AliasFormValues {
  const targets = Array.from(new Set(group.records.map((record) => record.target)));
  const targetProviderValues = Array.from(new Set(
    group.records.map((record) => record.targetProvider || 'auto')
  ));
  return normalizeAliasForm({
    alias: group.alias,
    target: targets,
    provider: group.provider,
    targetProvider: targetProviderValues.length > 0 ? targetProviderValues : ['auto'],
    priority: group.records[0]?.priority ?? 0,
    enabled: group.enabled,
    description: group.description
  });
}

// 移动端（< 768px）由 web/src/mobile/pages/MobileSettings 的别名分区独立渲染，这里只保留桌面表格。
const ModelAliases: React.FC<{ setActions?: (actions: React.ReactNode) => void }> = ({ setActions }) => {
  const {
    sortedAliases,
    loading,
    lastError,
    modelsByProvider,
    modelsLoading,
    fetchModels,
    getModelLabel,
    findModelLabel,
    deleteAliases,
    toggleAlias: handleToggle,
    saveAlias
  } = useModelAliases();

  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<AliasFormValues>();
  const [editingGroup, setEditingGroup] = useState<AliasGroup | null>(null);
  const [panelFeedback, setPanelFeedback] = useState<InlineFeedback | null>(null);
  const [modalFeedback, setModalFeedback] = useState<InlineFeedback | null>(null);

  const watchedForm = Form.useWatch([], form) as Partial<AliasFormValues> | undefined;
  const watchedTargetProviders = Form.useWatch('targetProvider', form);
  const targetProviders = useMemo<string[]>(() => {
    if (Array.isArray(watchedTargetProviders)) return watchedTargetProviders;
    if (typeof watchedTargetProviders === 'string' && watchedTargetProviders) return [watchedTargetProviders];
    return [];
  }, [watchedTargetProviders]);

  const handleAdd = useCallback(() => {
    form.resetFields();
    form.setFieldsValue({
      ...MODEL_ALIAS_FORM_DEFAULTS,
      alias: '',
      description: ''
    });
    setEditingGroup(null);
    setModalFeedback(null);
    setModalVisible(true);
  }, [form]);

  useEffect(() => {
    if (!setActions) return;
    setActions(
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加别名
        </Button>
        <Button icon={<ReloadOutlined />} loading={modelsLoading} onClick={() => void fetchModels(true)}>
          重新读取缓存
        </Button>
      </Space>
    );
  }, [fetchModels, handleAdd, modelsLoading, setActions]);

  useEffect(() => {
    return () => {
      setActions?.(null);
    };
  }, [setActions]);

  const renderProviderOptions = () => PROVIDER_SELECT_OPTIONS.map((option) => (
    <Select.Option key={option.value} value={option.value}>
      {option.label}
    </Select.Option>
  ));

  const targetModelGroups = useMemo(
    () => buildTargetModelGroups(modelsByProvider, targetProviders, editingGroup?.records || []),
    [modelsByProvider, targetProviders, editingGroup]
  );

  const aliasGroups = useMemo(() => groupModelAliases(sortedAliases), [sortedAliases]);

  const persistedFormValues = useMemo<AliasFormValues>(() => (
    editingGroup
      ? buildGroupFormValues(editingGroup)
      : normalizeAliasForm(MODEL_ALIAS_FORM_DEFAULTS)
  ), [editingGroup]);

  const draftFormValues = useMemo(
    () => normalizeAliasForm(watchedForm ?? persistedFormValues),
    [persistedFormValues, watchedForm]
  );

  const formDirty = editingGroup
    ? !aliasFormsEqual(draftFormValues, persistedFormValues)
    : Boolean(draftFormValues.alias && draftFormValues.target.length > 0);

  const handleEdit = (group: AliasGroup) => {
    const initial = buildGroupFormValues(group);
    form.setFieldsValue(initial);
    setEditingGroup(group);
    setModalFeedback(null);
    setModalVisible(true);
  };

  const handleModalSave = async () => {
    if (!formDirty) return;
    setModalFeedback(null);
    let values: AliasFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const records = expandAliasSelections(values, modelsByProvider);
      const replaceIds = editingGroup ? editingGroup.records.map((record) => record.id) : null;
      const ok = await saveAlias(replaceIds, { ...values, records });
      if (ok) {
        setEditingGroup(null);
        setModalVisible(false);
        setPanelFeedback({
          tone: 'success',
          text: replaceIds
            ? `已更新别名 ${values.alias.trim()} 并立即生效`
            : `已添加别名 ${values.alias.trim()}（${records.length} 条映射）并立即生效`
        });
      } else {
        setModalFeedback({
          tone: 'error',
          text: '保存失败，请检查目标模型与供应商组合是否有效'
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: '别名',
      dataIndex: 'alias',
      key: 'alias',
      render: (text: string) => <strong className="model-alias-name">{text}</strong>
    },
    {
      title: '目标模型',
      key: 'target',
      width: 320,
      render: (_: unknown, group: AliasGroup) => (
        <div className="model-alias-target-list">
          {group.records.map((record) => {
            const label = findModelLabel(record.target);
            return (
              <span key={record.id} className="model-alias-target">
                <Tooltip title={label ? `${record.target} (${label})` : record.target}>
                  <Typography.Text className="model-alias-target-id" ellipsis>
                    {record.target}
                  </Typography.Text>
                </Tooltip>
                {label ? <span className="model-alias-target-label">({label})</span> : null}
                <span className="model-alias-target-scope">
                  {formatAliasTargetProvider(record.targetProvider)}
                </span>
              </span>
            );
          })}
        </div>
      )
    },
    {
      title: '优先级',
      key: 'priority',
      width: 84,
      render: (_: unknown, group: AliasGroup) => (
        <span className="model-alias-priority">{Number(group.records[0]?.priority) || 0}</span>
      )
    },
    {
      title: '请求范围',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: string) => formatAliasScope(text)
    },
    {
      title: '条数',
      key: 'count',
      width: 72,
      render: (_: unknown, group: AliasGroup) => (
        <span className="model-alias-priority">{group.records.length}</span>
      )
    },
    {
      title: '备注',
      dataIndex: 'description',
      key: 'description',
      render: (text: string) => text || <span className="aih-muted">—</span>
    },
    {
      title: '状态',
      key: 'enabled',
      width: 150,
      render: (_: unknown, group: AliasGroup) => (
        <Space size={8}>
          <Switch
            size="small"
            checked={group.enabled}
            onChange={async () => {
              const anyEnabled = group.records.some((record) => record.enabled !== false);
              let allOk = true;
              for (const record of group.records) {
                if ((record.enabled !== false) === anyEnabled) {
                  const ok = await handleToggle(record.id);
                  if (!ok) allOk = false;
                }
              }
              setPanelFeedback(allOk
                ? { tone: 'success', text: `别名 ${group.alias} 已${anyEnabled ? '停用' : '启用'}并立即生效` }
                : { tone: 'error', text: `更新别名 ${group.alias} 状态失败` });
            }}
          />
          <SettingStatusTag
            status={group.enabled ? 'applied' : 'unset'}
            label={group.enabled ? '已启用' : '已停用'}
            compact
            live="off"
          />
        </Space>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 148,
      render: (_: unknown, group: AliasGroup) => (
        <Space size="small">
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(group)}>
            编辑
          </Button>
          <Popconfirm
            title={`确定删除 ${group.alias} 的全部 ${group.records.length} 条记录？`}
            onConfirm={async () => {
              const ok = await deleteAliases(group.records.map((record) => record.id));
              setPanelFeedback(ok
                ? { tone: 'success', text: `已删除别名 ${group.alias}` }
                : { tone: 'error', text: `删除别名 ${group.alias} 失败` });
            }}
            okText="删除"
            cancelText="取消"
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const sectionStatus: { status: SettingStatusState; label: string } = loading
    ? { status: 'saving', label: '同步中' }
    : panelFeedback?.tone === 'error' || lastError
      ? { status: 'error', label: '操作失败' }
      : aliasGroups.length > 0
        ? { status: 'applied', label: `已生效 · ${aliasGroups.length} 组` }
        : { status: 'unset', label: '未配置别名' };

  const modalStatus: SettingStatusState = saving
    ? 'saving'
    : modalFeedback?.tone === 'error'
      ? 'error'
      : formDirty
        ? 'dirty'
        : editingGroup
          ? 'applied'
          : 'unset';

  return (
    <div className="gateway-settings-stack">
      <SettingSection
        title="模型别名"
        description="将客户端请求的模型名路由到指定目标模型，支持优先级回退与立即热生效。"
        status={<SettingStatusTag status={sectionStatus.status} label={sectionStatus.label} compact />}
        extra={!setActions ? (
          <Space size={8} wrap>
            <Button icon={<ReloadOutlined />} loading={modelsLoading} onClick={() => void fetchModels(true)}>
              重新读取缓存
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              添加别名
            </Button>
          </Space>
        ) : undefined}
      >
        {panelFeedback || lastError ? (
          <div
            className={`gateway-inline-feedback gateway-inline-feedback--${panelFeedback ? panelFeedback.tone : 'error'}`}
            role={(panelFeedback?.tone === 'error' || (!panelFeedback && lastError)) ? 'alert' : 'status'}
          >
            <SettingStatusTag
              status={(panelFeedback?.tone === 'error' || (!panelFeedback && lastError)) ? 'error' : 'applied'}
              label={(panelFeedback?.tone === 'error' || (!panelFeedback && lastError)) ? '失败' : '已生效'}
              compact
              live="off"
            />
            <span>{panelFeedback?.text || lastError}</span>
          </div>
        ) : null}

        <ListTable
          dataSource={aliasGroups}
          columns={columns}
          rowKey="alias"
          loading={loading}
          scroll={{ x: 960 }}
        />

        {aliasGroups.length === 0 && !loading ? (
          <p className="gateway-empty-note">暂无模型别名。点击「添加别名」即可配置请求模型映射与回退规则。</p>
        ) : null}
      </SettingSection>

      <Modal
        title={editingGroup ? `编辑模型别名 · ${editingGroup.alias}` : '添加模型别名'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        destroyOnClose={false}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={MODEL_ALIAS_FORM_DEFAULTS}
          onValuesChange={() => {
            if (modalFeedback) setModalFeedback(null);
          }}
        >
          <Form.Item
            name="alias"
            label="别名"
            rules={MODEL_ALIAS_FIELD_RULES.alias}
            help={MODEL_ALIAS_FIELD_HELP.alias}
          >
            <Input placeholder="例如 claude-sonnet 或 gpt-*" className="model-alias-mono-input" />
          </Form.Item>

          <Form.Item
            name="target"
            label="目标模型"
            rules={MODEL_ALIAS_FIELD_RULES.target}
            help={MODEL_ALIAS_FIELD_HELP.target}
          >
            <Select
              mode="multiple"
              showSearch
              loading={modelsLoading}
              placeholder={targetModelGroups.length === 0 ? '暂无可用目标模型，请先读取缓存' : '选择一个或多个目标模型'}
              optionFilterProp="children"
              disabled={targetModelGroups.length === 0}
              maxTagCount="responsive"
            >
              {targetModelGroups.map((group) => (
                <Select.OptGroup key={group.provider} label={getAliasProviderDisplayName(group.provider)}>
                  {group.models.map((model) => {
                    const label = getModelLabel(group.provider, model);
                    return (
                      <Select.Option key={`${group.provider}:${model}`} value={model}>
                        {label ? `${model} — ${label}` : model}
                      </Select.Option>
                    );
                  })}
                </Select.OptGroup>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="provider"
            label="请求范围"
            rules={MODEL_ALIAS_FIELD_RULES.provider}
            help={MODEL_ALIAS_FIELD_HELP.provider}
          >
            <Select>
              <Select.Option value="all">全部 (All)</Select.Option>
              {renderProviderOptions()}
            </Select>
          </Form.Item>

          <Form.Item
            name="targetProvider"
            label="目标供应商"
            rules={MODEL_ALIAS_FIELD_RULES.targetProvider}
            help={MODEL_ALIAS_FIELD_HELP.targetProvider}
          >
            <Select
              mode="multiple"
              maxTagCount="responsive"
              placeholder="默认自动"
              onChange={() => {
                const nextProviders = form.getFieldValue('targetProvider');
                const selected = form.getFieldValue('target');
                if (!Array.isArray(selected) || selected.length === 0) return;
                const groups = buildTargetModelGroups(modelsByProvider, nextProviders, editingGroup?.records || []);
                const allowed = new Set(groups.flatMap((group) => group.models));
                const kept = selected.filter((model: string) => allowed.has(model));
                if (kept.length !== selected.length) form.setFieldValue('target', kept);
              }}
            >
              <Select.Option value="auto">自动 (Auto)</Select.Option>
              {renderProviderOptions()}
            </Select>
          </Form.Item>

          <Form.Item
            name="priority"
            label="优先级"
            help={MODEL_ALIAS_FIELD_HELP.priority}
          >
            <InputNumber precision={0} style={{ width: '100%' }} placeholder="默认 0" />
          </Form.Item>

          <Form.Item name="description" label="备注">
            <Input.TextArea placeholder="可选备注" autoSize={{ minRows: 2, maxRows: 3 }} />
          </Form.Item>

          <Form.Item name="enabled" label="启用状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>

        <div className="gateway-modal-footer">
          <SaveActionBar
            dirty={formDirty}
            saving={saving}
            status={modalStatus}
            statusLabel={!editingGroup && !formDirty ? '待填写别名与目标' : undefined}
            saveLabel={editingGroup ? '保存更改' : '创建别名'}
            cleanSaveLabel={editingGroup ? '已应用' : '请填写必填项'}
            effectSummary="保存后立即作用于网关模型路由"
            feedback={modalFeedback?.text}
            feedbackTone={modalFeedback?.tone ?? 'muted'}
            onSave={() => void handleModalSave()}
            onReset={editingGroup ? () => {
              form.setFieldsValue(persistedFormValues);
              setModalFeedback(null);
            } : undefined}
            extraActions={(
              <Button disabled={saving} onClick={() => setModalVisible(false)}>
                取消
              </Button>
            )}
          />
        </div>
      </Modal>
    </div>
  );
};

export default ModelAliases;
