import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UpstreamErrorMappingGroup } from '@/types';
import { upstreamErrorMappingsAPI } from '@/services/api';
import { UpstreamErrorRulesEditor } from '@/features/accounts/UpstreamErrorRulesEditor';
import {
  createUpstreamErrorMappingGroup,
  UPSTREAM_ERROR_PROVIDER_OPTIONS,
  upstreamErrorProviderLabel
} from '@/features/accounts/upstream-error-mapping-presets';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SaveActionBar from '@/components/ui/SaveActionBar';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';

interface UpstreamErrorMappingsProps {
  setActions?: (actions: ReactNode) => void;
}

type InlineFeedback = {
  tone: 'success' | 'error';
  text: string;
};

interface MappingGroupEditorModalProps {
  open: boolean;
  editingId: string | null;
  form: ReturnType<typeof Form.useForm>[0];
  dirty: boolean;
  saving: boolean;
  errorText: string;
  onCancel: () => void;
  onSave: () => void;
  onValuesChange: () => void;
}

function MappingGroupEditorModal({
  open,
  editingId,
  form,
  dirty,
  saving,
  errorText,
  onCancel,
  onSave,
  onValuesChange
}: MappingGroupEditorModalProps) {
  return (
    <Modal
      title={editingId ? '编辑异常映射组' : '添加异常映射组'}
      open={open}
      width="min(960px, calc(100vw - 24px))"
      destroyOnClose
      footer={null}
      onCancel={onCancel}
    >
      <Form
        form={form}
        layout="vertical"
        onValuesChange={onValuesChange}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {errorText ? <InlineNote tone="error">{errorText}</InlineNote> : null}

        <SettingSection
          title="基本配置"
          description="定义映射组名称、适用 Provider 与启停状态。"
          status={
            saving
              ? <SettingStatusTag status="saving" compact />
              : dirty
                ? <SettingStatusTag status="dirty" label="未保存草稿" compact />
                : <SettingStatusTag status="saved" label={editingId ? '已同步' : '新建草稿'} compact />
          }
        >
          <SettingRow
            title="映射组名称"
            description="用于账号配置中选择与排障识别。"
            htmlFor="uem-name"
            control={(
              <Form.Item
                name="name"
                rules={[{ required: true, message: '请输入映射组名称' }, { max: 80 }]}
                style={{ marginBottom: 0, width: '100%' }}
              >
                <Input id="uem-name" placeholder="例如：New API 余额不足" />
              </Form.Item>
            )}
          />
          <SettingRow
            title="适用 Provider"
            description="仅对所选 Provider 的上游响应生效。"
            htmlFor="uem-provider"
            control={(
              <Form.Item
                name="provider"
                rules={[{ required: true, message: '请选择适用 Provider' }]}
                style={{ marginBottom: 0, width: '100%' }}
              >
                <Select id="uem-provider" options={UPSTREAM_ERROR_PROVIDER_OPTIONS} />
              </Form.Item>
            )}
          />
          <SettingRow
            title="启用状态"
            description="停用后保留规则但不参与运行池错误判定。"
            htmlFor="uem-enabled"
            control={(
              <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Switch id="uem-enabled" checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
            )}
          />
          <SettingRow
            title="规则说明"
            description="可选，简要记录匹配的上游错误格式与目标状态。"
            htmlFor="uem-description"
            layout="stacked"
            control={(
              <Form.Item name="description" rules={[{ max: 240 }]} style={{ marginBottom: 0 }}>
                <Input.TextArea id="uem-description" rows={2} placeholder="说明匹配的上游格式和转换结果" />
              </Form.Item>
            )}
          />
        </SettingSection>

        <SettingSection
          title="匹配与转换规则"
          description="按列表顺序依次匹配，同一规则内各条件同时满足才命中。"
          footer={(
            <SaveActionBar
              dirty={dirty || !editingId}
              saving={saving}
              onSave={onSave}
              saveLabel={editingId ? '保存修改' : '创建映射组'}
              cleanSaveLabel="已同步"
              effectSummary="保存后对新挂载与下次运行池刷新生效"
              feedback={errorText || undefined}
              feedbackTone={errorText ? 'error' : 'muted'}
              extraActions={(
                <Button disabled={saving} onClick={onCancel}>取消</Button>
              )}
            />
          )}
        >
          <div style={{ padding: '12px 18px' }}>
            <UpstreamErrorRulesEditor listName="rules" includeGroups={false} />
          </div>
        </SettingSection>
      </Form>
    </Modal>
  );
}

export default function UpstreamErrorMappings({ setActions }: UpstreamErrorMappingsProps) {
  const [form] = Form.useForm();
  const [groups, setGroups] = useState<UpstreamErrorMappingGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalDirty, setModalDirty] = useState(false);
  const [modalError, setModalError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const [busyId, setBusyId] = useState('');

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setGroups(await upstreamErrorMappingsAPI.getAll());
    } catch (error) {
      setLoadError(error instanceof Error ? `加载异常映射组失败：${error.message}` : '加载异常映射组失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setModalDirty(true);
    setModalError('');
    form.resetFields();
    form.setFieldsValue(createUpstreamErrorMappingGroup());
    setModalOpen(true);
  }, [form]);

  const openEdit = useCallback((group: UpstreamErrorMappingGroup) => {
    setEditingId(group.id);
    setModalDirty(false);
    setModalError('');
    form.resetFields();
    form.setFieldsValue(structuredClone(group));
    setModalOpen(true);
  }, [form]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalDirty(false);
    setModalError('');
    form.resetFields();
  }, [form]);

  const save = async () => {
    setModalError('');
    try {
      const values = await form.validateFields();
      setSaving(true);
      const saved = editingId
        ? await upstreamErrorMappingsAPI.update(editingId, values)
        : await upstreamErrorMappingsAPI.create(values);
      setGroups((current) => (
        editingId
          ? current.map((group) => (group.id === saved.id ? saved : group))
          : [...current, saved]
      ));
      closeModal();
      const text = editingId ? `已更新映射组「${saved.name}」` : `已创建映射组「${saved.name}」`;
      setFeedback({ tone: 'success', text });
      message.success(text);
    } catch (error: unknown) {
      const maybeFormErr = error as { errorFields?: unknown; response?: { data?: { message?: string } } };
      if (maybeFormErr?.errorFields) return;
      const text = maybeFormErr?.response?.data?.message || (error instanceof Error ? error.message : '保存映射组失败');
      setModalError(text);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!setActions) return undefined;
    setActions(
      <Space wrap>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadGroups()}>刷新</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加映射组</Button>
      </Space>
    );
    return () => setActions(null);
  }, [setActions, loading, loadGroups, openCreate]);

  const enabledCount = useMemo(
    () => groups.filter((group) => group.enabled !== false).length,
    [groups]
  );

  const columns = useMemo<ColumnsType<UpstreamErrorMappingGroup>>(() => [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: (value: string, group: UpstreamErrorMappingGroup) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          {group.description ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{group.description}</Typography.Text> : null}
        </Space>
      )
    },
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      width: 140,
      render: (value: string) => <Tag>{upstreamErrorProviderLabel(value)}</Tag>
    },
    {
      title: '规则数',
      key: 'rules',
      width: 100,
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => `${group.rules?.length || 0} 条`
    },
    {
      title: '状态',
      key: 'enabled',
      width: 120,
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => (
        <Switch
          size="small"
          loading={busyId === group.id}
          checked={group.enabled !== false}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={async () => {
            setBusyId(group.id);
            setFeedback(null);
            try {
              const saved = await upstreamErrorMappingsAPI.toggle(group.id);
              setGroups((current) => current.map((item) => (item.id === saved.id ? saved : item)));
              setFeedback({
                tone: 'success',
                text: `已${saved.enabled !== false ? '启用' : '停用'}「${saved.name}」`
              });
            } catch (error) {
              setFeedback({
                tone: 'error',
                text: error instanceof Error ? `切换状态失败：${error.message}` : '切换映射组状态失败'
              });
            } finally {
              setBusyId('');
            }
          }}
        />
      )
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_value: unknown, group: UpstreamErrorMappingGroup) => (
        <Space size={4}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(group)}>编辑</Button>
          <Popconfirm
            title="删除这个异常映射组？"
            description="已挂载该组的账号会在下次运行池刷新后停止使用。"
            okText="删除"
            cancelText="取消"
            onConfirm={async () => {
              setBusyId(group.id);
              setFeedback(null);
              try {
                await upstreamErrorMappingsAPI.delete(group.id);
                setGroups((current) => current.filter((item) => item.id !== group.id));
                setFeedback({ tone: 'success', text: `已删除映射组「${group.name}」` });
              } catch (error) {
                setFeedback({
                  tone: 'error',
                  text: error instanceof Error ? `删除失败：${error.message}` : '删除映射组失败'
                });
              } finally {
                setBusyId('');
              }
            }}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ], [busyId, openEdit]);

  return (
    <>
      <SettingSection
        title="上游异常映射组"
        description="将不同 Provider 的错误响应映射为统一账号状态，供调度器决定冷却或换号。"
        status={
          loadError
            ? <SettingStatusTag status="error" label="加载失败" compact />
            : <SettingStatusTag status="applied" label={`启用 ${enabledCount}/${groups.length}`} compact />
        }
        extra={setActions ? undefined : (
          <Space wrap>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadGroups()}>刷新</Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加映射组</Button>
          </Space>
        )}
      >
        {loadError ? (
          <div style={{ padding: '12px 18px 0' }}>
            <InlineNote
              tone="error"
              action={<Button size="small" type="link" onClick={() => void loadGroups()}>重试</Button>}
            >
              {loadError}
            </InlineNote>
          </div>
        ) : null}
        {feedback ? (
          <div style={{ padding: '12px 18px 0' }}>
            <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>
          </div>
        ) : null}
        <div style={{ padding: '12px 18px', overflowX: 'auto' }}>
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={groups}
            columns={columns}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <HudStateView
                  compact
                  code="NO_ERROR_RULES"
                  title="暂无异常映射组"
                  description="添加自定义上游错误转换规则，将特定响应转为冷却或阻塞状态。"
                  extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加映射组</Button>}
                />
              )
            }}
          />
        </div>
      </SettingSection>

      <MappingGroupEditorModal
        open={modalOpen}
        editingId={editingId}
        form={form}
        dirty={modalDirty}
        saving={saving}
        errorText={modalError}
        onCancel={closeModal}
        onSave={() => void save()}
        onValuesChange={() => {
          setModalDirty(true);
          if (modalError) setModalError('');
        }}
      />
    </>
  );
}
