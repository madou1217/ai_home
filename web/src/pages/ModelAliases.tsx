import React, { useState, useEffect, useMemo } from 'react';
import { Space, Switch, Popconfirm, Form, Input, InputNumber, Select } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
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
import './ModelAliases.css';

// 移动端（< 768px）由 web/src/mobile/pages/MobileSettings 的别名分区独立渲染，这里只保留桌面表格。
const ModelAliases: React.FC<{ setActions?: (actions: React.ReactNode) => void }> = ({ setActions }) => {
  const {
    sortedAliases,
    loading,
    modelsByProvider,
    modelsLoading,
    fetchModels,
    getModelLabel,
    findModelLabel,
    deleteAlias: handleDelete,
    toggleAlias: handleToggle,
    saveAlias
  } = useModelAliases();
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<AliasGroup | null>(null);
  const watchedTargetProviders = Form.useWatch('targetProvider', form);
  const targetProviders = useMemo<string[]>(() => {
    if (Array.isArray(watchedTargetProviders)) return watchedTargetProviders;
    if (typeof watchedTargetProviders === 'string' && watchedTargetProviders) return [watchedTargetProviders];
    return [];
  }, [watchedTargetProviders]);

  useEffect(() => {
    if (!setActions) return;
    setActions(
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加别名
        </Button>
        <Button icon={<ReloadOutlined />} loading={modelsLoading} onClick={() => fetchModels(true)}>
          重新读取缓存
        </Button>
      </Space>
    );
  }, [setActions, modelsLoading]);

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
    () => buildTargetModelGroups(modelsByProvider, targetProviders),
    [modelsByProvider, targetProviders]
  );

  const aliasGroups = useMemo(() => groupModelAliases(sortedAliases), [sortedAliases]);

  const handleAdd = () => {
    form.resetFields();
    setEditingId(null);
    setEditingGroup(null);
    setModalVisible(true);
  };

  const handleEdit = (group: AliasGroup) => {
    // 聚合行编辑：把该别名的所有记录回填成多选值，保存时按笛卡尔积重建。
    const targets = Array.from(new Set(group.records.map((record) => record.target)));
    const targetProviderValues = Array.from(new Set(
      group.records.map((record) => record.targetProvider || 'auto')
    ));
    form.setFieldsValue({
      alias: group.alias,
      target: targets,
      provider: group.provider,
      targetProvider: targetProviderValues.length > 0 ? targetProviderValues : ['auto'],
      priority: group.records[0]?.priority ?? 0,
      enabled: group.enabled,
      description: group.description
    });
    setEditingId(null);
    setEditingGroup(group);
    setModalVisible(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      // 新增走多选展开；编辑态以聚合行覆盖：先删旧记录再按新值写入。
      const records = expandAliasSelections(values, modelsByProvider);
      if (editingGroup) {
        for (const record of editingGroup.records) await handleDelete(record.id);
      }
      if (await saveAlias(null, { ...values, records })) {
        setEditingGroup(null);
        setModalVisible(false);
      }
    } catch (e: any) {
      if (e?.errorFields) return; // Validation failed
    }
  };

  const columns = [
    {
      title: '别名 (Alias)',
      dataIndex: 'alias',
      key: 'alias',
      render: (text: any) => <strong className="model-alias-name">{text}</strong>,
    },
    {
      title: '目标模型 (Target)',
      key: 'target',
      render: (_: any, group: AliasGroup) => (
        <div className="model-alias-target-list">
          {group.records.map((record) => {
            const label = findModelLabel(record.target);
            return (
              <span key={record.id} className="model-alias-target">
                {record.target}
                {label ? <span className="model-alias-target-label">({label})</span> : null}
                <span className="model-alias-target-scope">
                  {formatAliasTargetProvider(record.targetProvider)}
                </span>
              </span>
            );
          })}
        </div>
      ),
    },
    {
      title: '优先级',
      key: 'priority',
      width: 90,
      render: (_: any, group: AliasGroup) => (
        <span className="model-alias-priority">{Number(group.records[0]?.priority) || 0}</span>
      ),
    },
    {
      title: '请求范围',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: any) => formatAliasScope(text),
    },
    {
      title: '条数',
      key: 'count',
      width: 80,
      render: (_: any, group: AliasGroup) => (
        <span className="model-alias-priority">{group.records.length}</span>
      ),
    },
    {
      title: '备注',
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: '状态',
      key: 'enabled',
      render: (_: any, group: AliasGroup) => (
        <Switch
          checked={group.enabled}
          onChange={async () => {
            const anyEnabled = group.records.some((record) => record.enabled !== false);
            for (const record of group.records) {
              if ((record.enabled !== false) === anyEnabled) await handleToggle(record.id);
            }
          }}
          checkedChildren="启用"
          unCheckedChildren="禁用"
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, group: AliasGroup) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(group)}>
            编辑
          </Button>
          <Popconfirm
            title={`确定要删除这个别名的全部 ${group.records.length} 条记录吗？`}
            onConfirm={async () => {
              for (const record of group.records) await handleDelete(record.id);
            }}
            okText="确定"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <SectionCard title="模型别名">
      <ListTable
        dataSource={aliasGroups}
        columns={columns}
        rowKey="alias"
        loading={loading}
      />

      <ModalForm
        title={editingId ? '编辑模型别名' : '添加模型别名'}
        open={modalVisible}
        onOpenChange={setModalVisible}
        form={form}
        onFinish={async () => {
          await handleModalOk();
          return true;
        }}
        submitter={{
          searchConfig: {
            submitText: '保存',
            resetText: '取消',
          },
        }}
        initialValues={MODEL_ALIAS_FORM_DEFAULTS}
        modalProps={{
          destroyOnClose: false,
        }}
        layout="vertical"
      >
          <Form.Item
            name="alias"
            label="别名 (Alias)"
            rules={MODEL_ALIAS_FIELD_RULES.alias}
            help={MODEL_ALIAS_FIELD_HELP.alias}
          >
            <Input placeholder="输入别名或尾部通配符" className="model-alias-mono-input" />
          </Form.Item>

          <Form.Item
            name="target"
            label="目标模型 (Target)"
            rules={MODEL_ALIAS_FIELD_RULES.target}
            help={MODEL_ALIAS_FIELD_HELP.target}
          >
            <Select
              mode="multiple"
              showSearch
              loading={modelsLoading}
              placeholder="可多选：选中的模型会按供应商展开成多条记录"
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
            label="请求范围 (Provider Scope)"
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
            label="目标供应商 (Target Provider)"
            rules={MODEL_ALIAS_FIELD_RULES.targetProvider}
            help={MODEL_ALIAS_FIELD_HELP.targetProvider}
          >
            <Select
              mode="multiple"
              maxTagCount="responsive"
              placeholder="可多选；自动 = 按模型自身归属"
              onChange={() => {
                // 供应商集合变化后，清掉不在所选目录里的模型选择，避免留下必然失败的组合。
                const nextProviders = form.getFieldValue('targetProvider');
                const selected = form.getFieldValue('target');
                if (!Array.isArray(selected) || selected.length === 0) return;
                const groups = buildTargetModelGroups(modelsByProvider, nextProviders);
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
            label="优先级 (Priority)"
            help={MODEL_ALIAS_FIELD_HELP.priority}
          >
            <InputNumber precision={0} style={{ width: '100%' }} placeholder="默认 0" />
          </Form.Item>

          <Form.Item
            name="description"
            label="备注"
          >
            <Input.TextArea placeholder="可选备注信息" />
          </Form.Item>

          <Form.Item
            name="enabled"
            label="状态"
            valuePropName="checked"
          >
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
      </ModalForm>
    </SectionCard>
  );
};

export default ModelAliases;