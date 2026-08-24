import { useEffect, useMemo, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { proxyPoolAPI } from '@/services/api';
import type { ProxyGroup, ProxyGroupStrategy, ProxyNode } from '@/types';
import {
  PROXY_GROUP_STRATEGY_OPTIONS,
  describeProxyGroupKind,
  formatProxyGroupLabel,
  formatProxyNodeLabel
} from './zcode-egress-presentation';

interface GroupFormValues {
  name?: string;
  nodeIds?: string[];
  strategy: ProxyGroupStrategy;
  failoverStrategy: ProxyGroupStrategy;
}

interface ZcodeProxyGroupManagerModalProps {
  open: boolean;
  nodes: ProxyNode[];
  groups: ProxyGroup[];
  preferredGroupId?: string;
  onClose: () => void;
  onChanged: (groups: ProxyGroup[], preferredGroupId?: string) => void;
}

const DEFAULT_GROUP_VALUES: GroupFormValues = {
  name: '',
  nodeIds: [],
  strategy: 'sticky',
  failoverStrategy: 'lowest_latency'
};

function groupFormValues(group: ProxyGroup): GroupFormValues {
  return {
    name: group.name,
    nodeIds: [...(group.nodeIds || [])],
    strategy: group.strategy || 'sticky',
    failoverStrategy: group.failoverStrategy || 'lowest_latency'
  };
}

export function ZcodeProxyGroupManagerModal({
  open,
  nodes,
  groups,
  preferredGroupId,
  onClose,
  onChanged
}: ZcodeProxyGroupManagerModalProps) {
  const [form] = Form.useForm<GroupFormValues>();
  const [editingId, setEditingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === editingId) || null,
    [editingId, groups]
  );
  const editingManualGroup = creating || selectedGroup?.kind === 'manual';

  useEffect(() => {
    if (!open) return;
    const initial = groups.find((group) => group.id === preferredGroupId) || groups[0] || null;
    setCreating(false);
    setEditingId(initial?.id || '');
    form.setFieldsValue(initial ? groupFormValues(initial) : DEFAULT_GROUP_VALUES);
  }, [form, groups, open, preferredGroupId]);

  const groupOptions = useMemo(() => groups.map((group) => ({
    value: group.id,
    label: formatProxyGroupLabel(group)
  })), [groups]);
  const nodeOptions = useMemo(() => nodes.map((node) => ({
    value: node.id,
    label: formatProxyNodeLabel(node)
  })), [nodes]);

  const selectGroup = (groupId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    setCreating(false);
    setEditingId(group.id);
    form.setFieldsValue(groupFormValues(group));
  };

  const beginCreate = () => {
    setCreating(true);
    setEditingId('');
    form.setFieldsValue(DEFAULT_GROUP_VALUES);
  };

  const refreshGroups = async (nextPreferredGroupId?: string) => {
    const response = await proxyPoolAPI.listGroups();
    const nextGroups = response.groups || [];
    onChanged(nextGroups, nextPreferredGroupId);
    const selected = nextGroups.find((group) => group.id === nextPreferredGroupId) || nextGroups[0] || null;
    setCreating(false);
    setEditingId(selected?.id || '');
    form.setFieldsValue(selected ? groupFormValues(selected) : DEFAULT_GROUP_VALUES);
  };

  const saveGroup = async () => {
    if (submitting || (!creating && !selectedGroup)) return;
    let values: GroupFormValues;
    try {
      values = await form.validateFields(
        editingManualGroup
          ? ['name', 'nodeIds', 'strategy', 'failoverStrategy']
          : ['strategy', 'failoverStrategy']
      );
    } catch {
      return;
    }

    setSubmitting(true);
    try {
      const response = editingManualGroup
        ? await proxyPoolAPI.upsertGroup({
          ...(creating ? {} : { id: selectedGroup?.id }),
          name: String(values.name || '').trim(),
          nodeIds: values.nodeIds || [],
          strategy: values.strategy,
          failoverStrategy: values.failoverStrategy
        })
        : await proxyPoolAPI.updateGroupPolicy(selectedGroup!.id, {
          strategy: values.strategy,
          failoverStrategy: values.failoverStrategy
        });
      const nextId = response.group?.id || selectedGroup?.id;
      await refreshGroups(nextId);
      message.success(editingManualGroup ? '手动分组已保存' : '自动分组策略已更新');
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '保存代理分组失败');
    } finally {
      setSubmitting(false);
    }
  };

  const deleteGroup = () => {
    if (!selectedGroup || selectedGroup.kind !== 'manual' || submitting) return;
    Modal.confirm({
      title: `删除手动分组“${selectedGroup.name}”？`,
      content: '只删除分组，不会删除其中的代理节点。引用该分组的账号需重新选择出口。',
      okText: '删除分组',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setSubmitting(true);
        try {
          await proxyPoolAPI.deleteGroup(selectedGroup.id);
          await refreshGroups();
          message.success('手动分组已删除');
        } catch (error: any) {
          message.error(error?.response?.data?.error || error?.message || '删除代理分组失败');
          throw error;
        } finally {
          setSubmitting(false);
        }
      }
    });
  };

  return (
    <Modal
      open={open}
      title="代理分组与调度策略"
      width={680}
      destroyOnHidden
      maskClosable={!submitting}
      onCancel={onClose}
      footer={[
        <Button
          key="delete"
          danger
          icon={<DeleteOutlined />}
          disabled={selectedGroup?.kind !== 'manual' || submitting}
          onClick={deleteGroup}
        >
          删除手动组
        </Button>,
        <Button key="close" disabled={submitting} onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={submitting}
          disabled={!creating && !selectedGroup}
          onClick={() => void saveGroup()}
        >
          保存
        </Button>
      ]}
    >
      <Space wrap style={{ width: '100%', marginBottom: 16 }}>
        <Select
          style={{ minWidth: 360 }}
          showSearch
          optionFilterProp="label"
          value={creating ? undefined : editingId || undefined}
          placeholder="选择已有分组"
          options={groupOptions}
          disabled={creating || submitting}
          onChange={selectGroup}
        />
        <Button icon={<PlusOutlined />} disabled={submitting} onClick={beginCreate}>
          新建手动组
        </Button>
      </Space>

      {creating || selectedGroup ? (
        <>
          <Space wrap size={8} style={{ marginBottom: 12 }}>
            <Tag color={editingManualGroup ? 'blue' : 'default'}>
              {creating ? '新手动组' : describeProxyGroupKind(selectedGroup)}
            </Tag>
            {!creating && selectedGroup ? <Tag>{selectedGroup.count} 个节点</Tag> : null}
            {!editingManualGroup ? (
              <Typography.Text type="secondary">
                自动组成员由订阅、国家或系统规则生成，这里只调整调度策略。
              </Typography.Text>
            ) : null}
          </Space>
          <Form form={form} layout="vertical" initialValues={DEFAULT_GROUP_VALUES}>
            {editingManualGroup ? (
              <>
                <Form.Item
                  name="name"
                  label="分组名称"
                  rules={[{ required: true, whitespace: true, message: '请输入分组名称' }]}
                >
                  <Input placeholder="例如：分组 A" maxLength={80} />
                </Form.Item>
                <Form.Item
                  name="nodeIds"
                  label="分组成员"
                  rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个代理节点' }]}
                >
                  <Select
                    mode="multiple"
                    showSearch
                    optionFilterProp="label"
                    placeholder="选择代理节点"
                    options={nodeOptions}
                    maxTagCount="responsive"
                  />
                </Form.Item>
              </>
            ) : null}
            <Form.Item name="strategy" label="首次选择与常规调度策略" rules={[{ required: true }]}>
              <Select options={PROXY_GROUP_STRATEGY_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="failoverStrategy"
              label="当前节点不可用时的故障切换策略"
              rules={[{ required: true }]}
            >
              <Select options={PROXY_GROUP_STRATEGY_OPTIONS} />
            </Form.Item>
          </Form>
        </>
      ) : (
        <Typography.Text type="secondary">当前没有可管理的代理分组，可新建手动组。</Typography.Text>
      )}
    </Modal>
  );
}
