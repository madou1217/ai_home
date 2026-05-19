import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Switch, Popconfirm, message, Modal, Form, Input, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { modelAliasesAPI, ModelAlias } from '@/services/api';

const ModelAliases: React.FC = () => {
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<string | null>(null);

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

  useEffect(() => {
    fetchAliases();
  }, []);

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
      render: (text: string) => <strong>{text}</strong>,
    },
    {
      title: '目标模型 (Target)',
      dataIndex: 'target',
      key: 'target',
    },
    {
      title: '请求范围',
      dataIndex: 'provider',
      key: 'provider',
      render: (text: string) => (text === 'all' ? '全部 (All)' : text),
    },
    {
      title: '目标供应商',
      dataIndex: 'targetProvider',
      key: 'targetProvider',
      render: (text: string) => (!text || text === 'auto' ? '自动 (Auto)' : text),
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
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加别名
        </Button>
      </div>
      <Table
        dataSource={aliases}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
      />

      <Modal
        title={editingId ? '编辑模型别名' : '添加模型别名'}
        open={modalVisible}
        onOk={handleModalOk}
        onCancel={() => setModalVisible(false)}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            provider: 'all',
            targetProvider: 'auto',
            enabled: true,
          }}
        >
          <Form.Item
            name="alias"
            label="别名 (Alias)"
            rules={[{ required: true, message: '请输入别名' }]}
            help="客户端请求的模型名称，支持以 * 结尾作为通配符，例如 claude-*"
          >
            <Input placeholder="例如: claude-opus-4-7" />
          </Form.Item>

          <Form.Item
            name="target"
            label="目标模型 (Target)"
            rules={[{ required: true, message: '请输入目标模型' }]}
            help="实际转发到后端的模型名称"
          >
            <Input placeholder="例如: Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf" />
          </Form.Item>

          <Form.Item
            name="provider"
            label="请求范围 (Provider Scope)"
            rules={[{ required: true, message: '请选择供应商' }]}
            help="选择 '全部' 表示对所有请求生效，否则只对该特定供应商的请求生效"
          >
            <Select>
              <Select.Option value="all">全部 (All)</Select.Option>
              <Select.Option value="codex">Codex</Select.Option>
              <Select.Option value="gemini">Gemini</Select.Option>
              <Select.Option value="claude">Claude</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="targetProvider"
            label="目标供应商 (Target Provider)"
            rules={[{ required: true, message: '请选择目标供应商' }]}
            help="选择 '自动' 表示按目标模型自动识别；需要跨客户端固定路由时选择具体供应商"
          >
            <Select>
              <Select.Option value="auto">自动 (Auto)</Select.Option>
              <Select.Option value="codex">Codex</Select.Option>
              <Select.Option value="gemini">Gemini</Select.Option>
              <Select.Option value="claude">Claude</Select.Option>
            </Select>
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
        </Form>
      </Modal>
    </div>
  );
};

export default ModelAliases;
