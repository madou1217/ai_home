import React, { useState, useEffect, useMemo } from 'react';
import { Space, Switch, Popconfirm, Form, Input, InputNumber, Select } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ModelAlias } from '@/services/api';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import {
  ALIAS_PROVIDER_SELECT_OPTIONS as PROVIDER_SELECT_OPTIONS,
  MODEL_ALIAS_FIELD_HELP,
  MODEL_ALIAS_FIELD_RULES,
  MODEL_ALIAS_FORM_DEFAULTS,
  buildTargetModelGroups,
  formatAliasScope,
  formatAliasTargetProvider,
  getAliasProviderDisplayName
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
    providerHasModel,
    deleteAlias: handleDelete,
    toggleAlias: handleToggle,
    saveAlias
  } = useModelAliases();
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const targetProvider = Form.useWatch('targetProvider', form) || 'auto';

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
    () => buildTargetModelGroups(modelsByProvider, targetProvider),
    [modelsByProvider, targetProvider]
  );

  const handleAdd = () => {
    form.resetFields();
    setEditingId(null);
    setModalVisible(true);
  };

  const handleEdit = (record: ModelAlias) => {
    form.setFieldsValue({
      ...record,
      targetProvider: record.targetProvider || 'auto',
    });
    setEditingId(record.id);
    setModalVisible(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      if (await saveAlias(editingId, values)) setModalVisible(false);
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
      dataIndex: 'target',
      key: 'target',
      render: (text: any) => {
        const label = findModelLabel(text);
        return (
          <span className="model-alias-target">
            {text}
            {label ? <span className="model-alias-target-label">({label})</span> : null}
          </span>
        );
      },
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      render: (value: any) => <span className="model-alias-priority">{Number(value) || 0}</span>,
    },
    {
      title: '请求范围',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: any) => formatAliasScope(text),
    },
    {
      title: '目标供应商',
      dataIndex: 'targetProvider',
      key: 'targetProvider',
      render: (text: any) => formatAliasTargetProvider(text),
    },
    {
      title: '备注',
      dataIndex: 'description',
      key: 'description',
    },
    {
      title: '状态',
      key: 'enabled',
      render: (_: any, record: ModelAlias) => (
        <Switch
          checked={record.enabled !== false}
          onChange={() => handleToggle(record.id)}
          checkedChildren="启用"
          unCheckedChildren="禁用"
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ModelAlias) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确定要删除这个别名吗？"
            onConfirm={() => handleDelete(record.id)}
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
        dataSource={sortedAliases}
        columns={columns}
        rowKey="id"
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
              showSearch
              loading={modelsLoading}
              placeholder="选择真实模型"
              optionFilterProp="children"
              disabled={targetModelGroups.length === 0}
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
              onChange={(nextProvider) => {
                const selectedTarget = form.getFieldValue('target');
                if (!selectedTarget || nextProvider === 'auto') return;
                if (!providerHasModel(nextProvider, selectedTarget)) {
                  form.setFieldValue('target', undefined);
                }
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