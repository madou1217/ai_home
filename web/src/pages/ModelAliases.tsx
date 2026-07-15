import React, { useState, useEffect, useMemo } from 'react';
import { Space, Switch, Popconfirm, message, Form, Input, InputNumber, Select, Grid, Empty, Spin } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { modelAliasesAPI, modelsAPI, ModelAlias } from '@/services/api';
import Button from '@/components/ui/AppButton';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import '@/components/mobile/mobile-cards.css';

const PROVIDER_OPTIONS = providerIds;
const getProviderDisplayName = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;
const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((provider) => ({
  value: provider,
  label: getProviderDisplayName(provider)
}));

const ModelAliases: React.FC<{ setActions?: (actions: React.ReactNode) => void }> = ({ setActions }) => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [modelLabels, setModelLabels] = useState<Record<string, Record<string, string>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const targetProvider = Form.useWatch('targetProvider', form) || 'auto';

  const fetchAliases = async () => {
    setLoading(true);
    try {
      const data = await modelAliasesAPI.getAll();
      setAliases(data);
    } catch (e: any) {
      message.error(e?.message || '获取模型别名失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchModels = async (notify = false) => {
    setModelsLoading(true);
    try {
      const data = await modelsAPI.listCatalog();
      setModelsByProvider(data.models || {});
      setModelLabels(data.labels || {});
      if (notify) message.success('模型缓存已重新读取');
    } catch (e: any) {
      message.error(e?.message || '获取模型列表失败');
    } finally {
      setModelsLoading(false);
    }
  };

  // 上游 displayName 与 id 可能错位(如 gemini-3-flash-agent 显示为 Gemini 3.5 Flash (High)),
  // 下拉与表格都带上显示名,避免用户对不上号。
  const getModelLabel = (provider: string, model: string) => modelLabels[provider]?.[model] || '';
  const findModelLabel = (model: string) => {
    for (const provider of PROVIDER_OPTIONS) {
      const label = getModelLabel(provider, model);
      if (label) return label;
    }
    return '';
  };

  useEffect(() => {
    fetchAliases();
    fetchModels();
  }, []);

  useEffect(() => {
    if (!setActions) return;
    // 移动端与其他页面(账号/用量/仪表盘)统一:头部用紧凑 m-icon-btn 图标按钮,不用会把标题挤没的
    // 全文字按钮;桌面保留带文字的按钮。
    setActions(isMobile ? (
      <div className="m-header-actions">
        <button className="m-icon-btn" aria-label="重新读取缓存" disabled={modelsLoading} onClick={() => fetchModels(true)}>
          <ReloadOutlined spin={modelsLoading} />
        </button>
        <button className="m-icon-btn primary" aria-label="添加别名" onClick={handleAdd}>
          <PlusOutlined />
        </button>
      </div>
    ) : (
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加别名
        </Button>
        <Button icon={<ReloadOutlined />} loading={modelsLoading} onClick={() => fetchModels(true)}>
          重新读取缓存
        </Button>
      </Space>
    ));
  }, [setActions, modelsLoading, isMobile]);

  useEffect(() => {
    return () => {
      setActions?.(null);
    };
  }, [setActions]);

  const providerHasModel = (provider: string, model: string) => {
    return (modelsByProvider[provider] || []).includes(model);
  };

  const renderProviderOptions = () => PROVIDER_SELECT_OPTIONS.map((option) => (
    <Select.Option key={option.value} value={option.value}>
      {option.label}
    </Select.Option>
  ));

  // 同名别名相邻展示,组内按优先级降序(与运行时回退顺序一致)
  const sortedAliases = useMemo(() => {
    return [...aliases].sort((a, b) => {
      const aliasDelta = a.alias.localeCompare(b.alias);
      if (aliasDelta !== 0) return aliasDelta;
      return (Number(b.priority) || 0) - (Number(a.priority) || 0);
    });
  }, [aliases]);

  const targetModelGroups = useMemo(() => {
    const providers = targetProvider && targetProvider !== 'auto'
      ? [targetProvider]
      : PROVIDER_OPTIONS;
    return providers
      .map((provider) => ({
        provider,
        models: Array.from(new Set(modelsByProvider[provider] || [])).sort(),
      }))
      .filter((group) => group.models.length > 0);
  }, [modelsByProvider, targetProvider]);

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

  const handleDelete = async (id: string) => {
    try {
      await modelAliasesAPI.delete(id);
      message.success('删除成功');
      fetchAliases();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await modelAliasesAPI.toggle(id);
      message.success('状态已更新');
      fetchAliases();
    } catch (e: any) {
      message.error(e?.message || '更新状态失败');
    }
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      if (editingId) {
        await modelAliasesAPI.update(editingId, values);
        message.success('更新成功');
      } else {
        await modelAliasesAPI.create(values);
        message.success('添加成功');
      }
      setModalVisible(false);
      fetchAliases();
    } catch (e: any) {
      if (e?.errorFields) return; // Validation failed
      message.error(e?.message || '保存失败');
    }
  };

  const columns = [
    {
      title: '别名 (Alias)',
      dataIndex: 'alias',
      key: 'alias',
      render: (text: any) => <strong>{text}</strong>,
    },
    {
      title: '目标模型 (Target)',
      dataIndex: 'target',
      key: 'target',
      render: (text: any) => {
        const label = findModelLabel(text);
        return (
          <span>
            {text}
            {label ? <span style={{ color: '#999', marginLeft: 6 }}>({label})</span> : null}
          </span>
        );
      },
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
      render: (value: any) => Number(value) || 0,
    },
    {
      title: '请求范围',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: any) => (text === 'all' ? '全部 (All)' : getProviderDisplayName(text)),
    },
    {
      title: '目标供应商',
      dataIndex: 'targetProvider',
      key: 'targetProvider',
      render: (text: any) => (!text || text === 'auto' ? '自动 (Auto)' : getProviderDisplayName(text)),
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

  // 移动端别名卡片 —— 每条别名一张卡（§2 表格→卡片列表）。整表渲染、无分页，滚动即看全（手机不做显式分页）。
  const renderAliasCard = (record: ModelAlias) => {
    const label = findModelLabel(record.target);
    return (
      <div className="mobile-card" key={record.id}>
        <div className="mobile-card-head">
          <div className="mobile-card-head-main">
            <div className="mobile-card-title"><span className="mobile-card-title-text">{record.alias}</span></div>
            <div className="mobile-card-subtitle">
              {record.target}{label ? ` (${label})` : ''}
            </div>
          </div>
          <div className="mobile-card-head-action">
            <Switch
              checked={record.enabled !== false}
              onChange={() => handleToggle(record.id)}
              checkedChildren="启用"
              unCheckedChildren="禁用"
              size="small"
            />
          </div>
        </div>
        <div className="mobile-card-meta">
          <div className="mobile-card-meta-item">
            <span className="mobile-card-meta-label">优先级</span>
            <span className="mobile-card-meta-value">{Number(record.priority) || 0}</span>
          </div>
          <div className="mobile-card-meta-item">
            <span className="mobile-card-meta-label">请求范围</span>
            <span className="mobile-card-meta-value">{record.provider === 'all' ? '全部 (All)' : getProviderDisplayName(record.provider)}</span>
          </div>
          <div className="mobile-card-meta-item">
            <span className="mobile-card-meta-label">目标供应商</span>
            <span className="mobile-card-meta-value">{!record.targetProvider || record.targetProvider === 'auto' ? '自动 (Auto)' : getProviderDisplayName(record.targetProvider)}</span>
          </div>
        </div>
        {record.description ? (
          <div className="mobile-card-subtitle" style={{ marginTop: 8, whiteSpace: 'normal' }}>{record.description}</div>
        ) : null}
        <div className="mobile-card-foot">
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm
            title="确定要删除这个别名吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </div>
      </div>
    );
  };

  return (
    <SectionCard title="模型别名">
      {isMobile ? (
        loading && sortedAliases.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}><Spin /></div>
        ) : sortedAliases.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型别名" style={{ padding: '32px 0' }} />
        ) : (
          <div className="mobile-card-list">{sortedAliases.map(renderAliasCard)}</div>
        )
      ) : (
        <ListTable
          dataSource={sortedAliases}
          columns={columns}
          rowKey="id"
          loading={loading}
        />
      )}

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
        initialValues={{
          provider: 'all',
          targetProvider: 'auto',
          priority: 0,
          enabled: true,
        }}
        modalProps={{
          destroyOnClose: false,
        }}
        layout="vertical"
      >
          <Form.Item
            name="alias"
            label="别名 (Alias)"
            rules={[{ required: true, message: '请输入别名' }]}
            help="客户端请求的模型名称，通配符只能放在末尾且前缀至少 2 个字符"
          >
            <Input placeholder="输入别名或尾部通配符" />
          </Form.Item>

          <Form.Item
            name="target"
            label="目标模型 (Target)"
            rules={[{ required: true, message: '请选择目标模型' }]}
            help="实际转发到后端的模型名称"
          >
            <Select
              showSearch
              loading={modelsLoading}
              placeholder="选择真实模型"
              optionFilterProp="children"
              disabled={targetModelGroups.length === 0}
            >
              {targetModelGroups.map((group) => (
                <Select.OptGroup key={group.provider} label={getProviderDisplayName(group.provider)}>
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
            rules={[{ required: true, message: '请选择供应商' }]}
            help="选择 '全部' 表示对所有请求生效，否则只对该特定供应商的请求生效"
          >
            <Select>
              <Select.Option value="all">全部 (All)</Select.Option>
              {renderProviderOptions()}
            </Select>
          </Form.Item>

          <Form.Item
            name="targetProvider"
            label="目标供应商 (Target Provider)"
            rules={[{ required: true, message: '请选择目标供应商' }]}
            help="选择 '自动' 表示按目标模型自动识别；需要跨客户端固定路由时选择具体供应商"
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
            help="数字越大优先级越高;同名别名按优先级降序依次尝试,target 无可用账号时自动回退到下一条"
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