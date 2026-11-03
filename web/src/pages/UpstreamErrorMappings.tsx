import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { UpstreamErrorMappingGroup } from '@/types';
import { upstreamErrorMappingsAPI } from '@/services/api';
import { UpstreamErrorRulesEditor } from '@/features/accounts/UpstreamErrorRulesEditor';
import {
  createUpstreamErrorMappingGroup,
  UPSTREAM_ERROR_PROVIDER_OPTIONS,
  upstreamErrorProviderLabel
} from '@/features/accounts/upstream-error-mapping-presets';
import SectionCard from '@/components/ui/SectionCard';

interface UpstreamErrorMappingsProps {
  setActions?: (actions: ReactNode) => void;
}

export default function UpstreamErrorMappings({ setActions }: UpstreamErrorMappingsProps) {
  const [form] = Form.useForm();
  const [groups, setGroups] = useState<UpstreamErrorMappingGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadGroups = async () => {
    setLoading(true);
    try {
      setGroups(await upstreamErrorMappingsAPI.getAll());
    } catch (_error) {
      message.error('加载异常映射组失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGroups();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue(createUpstreamErrorMappingGroup());
    setModalOpen(true);
  };

  const openEdit = (group: UpstreamErrorMappingGroup) => {
    setEditingId(group.id);
    form.resetFields();
    form.setFieldsValue(structuredClone(group));
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    form.resetFields();
  };

  const save = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const saved = editingId
        ? await upstreamErrorMappingsAPI.update(editingId, values)
        : await upstreamErrorMappingsAPI.create(values);
      setGroups((current) => editingId
        ? current.map((group) => group.id === saved.id ? saved : group)
        : [...current, saved]);
      closeModal();
      message.success(editingId ? '映射组已更新' : '映射组已创建');
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.response?.data?.message || '保存映射组失败');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!setActions) return undefined;
    setActions(
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadGroups()}>刷新</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加映射组</Button>
      </Space>
    );
    return () => setActions(null);
  }, [setActions, loading]);

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, group: UpstreamErrorMappingGroup) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          {group.description ? <Typography.Text type="secondary">{group.description}</Typography.Text> : null}
        </Space>
      )
    },
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      render: (value: string) => <Tag>{upstreamErrorProviderLabel(value)}</Tag>
    },
    {
      title: '规则',
      key: 'rules',
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => `${group.rules?.length || 0} 条`
    },
    {
      title: '状态',
      key: 'enabled',
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => (
        <Switch
          checked={group.enabled !== false}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={async () => {
            try {
              const saved = await upstreamErrorMappingsAPI.toggle(group.id);
              setGroups((current) => current.map((item) => item.id === saved.id ? saved : item));
            } catch (_error) {
              message.error('切换映射组状态失败');
            }
          }}
        />
      )
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(group)}>编辑</Button>
          <Popconfirm
            title="删除这个异常映射组？"
            description="已挂载该组的账号会在下一次运行池刷新后停止使用它。"
            okText="删除"
            cancelText="取消"
            onConfirm={async () => {
              try {
                await upstreamErrorMappingsAPI.delete(group.id);
                setGroups((current) => current.filter((item) => item.id !== group.id));
                message.success('映射组已删除');
              } catch (_error) {
                message.error('删除映射组失败');
              }
            }}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <SectionCard title="上游异常映射">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          把不同 Provider 的错误响应转换为统一账号运行状态，再由调度器决定是否换号。规则按顺序匹配，条件之间为且关系。
        </Typography.Paragraph>
        <Table rowKey="id" loading={loading} dataSource={groups} columns={columns} pagination={false} />
      </SectionCard>
      <Modal
        title={editingId ? '编辑异常映射组' : '添加异常映射组'}
        open={modalOpen}
        width={960}
        destroyOnClose
        onCancel={closeModal}
        confirmLoading={saving}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space align="start" style={{ display: 'flex' }}>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入映射组名称' }, { max: 80 }]} style={{ flex: 1 }}>
              <Input placeholder="例如：New API 余额不足" />
            </Form.Item>
            <Form.Item name="provider" label="适用 Provider" rules={[{ required: true }]} style={{ width: 220 }}>
              <Select options={UPSTREAM_ERROR_PROVIDER_OPTIONS} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="说明" rules={[{ max: 240 }]}>
            <Input.TextArea rows={2} placeholder="说明匹配的上游格式和转换结果" />
          </Form.Item>
          <UpstreamErrorRulesEditor listName="rules" includeGroups={false} />
        </Form>
      </Modal>
    </>
  );
}
