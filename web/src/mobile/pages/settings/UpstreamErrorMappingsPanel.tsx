import { DeleteOutlined, EditOutlined, PlusOutlined, PoweroffOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Form, Input, Select, Switch, message } from 'antd';
import { useEffect, useState } from 'react';
import type { UpstreamErrorMappingGroup } from '@/types';
import { upstreamErrorMappingsAPI } from '@/services/api';
import { UpstreamErrorRulesEditor } from '@/features/accounts/UpstreamErrorRulesEditor';
import {
  createUpstreamErrorMappingGroup,
  UPSTREAM_ERROR_PROVIDER_OPTIONS,
  upstreamErrorProviderLabel
} from '@/features/accounts/upstream-error-mapping-presets';
import { confirmAction } from '@/utils/confirm-action';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudIconButton,
  HudSection,
  KeyValue,
  MobileToolbar,
  MonoList,
  SwipeRow
} from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import styles from './MobileSettings.module.css';

export default function UpstreamErrorMappingsPanel() {
  const [form] = Form.useForm();
  const [groups, setGroups] = useState<UpstreamErrorMappingGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<UpstreamErrorMappingGroup | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const loadGroups = async () => {
    setLoading(true);
    try {
      setGroups(await upstreamErrorMappingsAPI.getAll());
    } catch (_error) {
      message.error('加载异常映射组失败');
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGroups();
  }, []);

  useEffect(() => {
    if (!formOpen) return;
    form.resetFields();
    form.setFieldsValue(editing ? structuredClone(editing) : createUpstreamErrorMappingGroup());
  }, [form, formOpen, editing]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (group: UpstreamErrorMappingGroup) => {
    setDetailId(null);
    setEditing(group);
    setFormOpen(true);
  };

  const save = async () => {
    let values: Partial<UpstreamErrorMappingGroup>;
    try {
      values = await form.validateFields();
    } catch (_error) {
      return;
    }
    setSaving(true);
    try {
      const saved = editing
        ? await upstreamErrorMappingsAPI.update(editing.id, values)
        : await upstreamErrorMappingsAPI.create(values);
      setGroups((current) => editing
        ? current.map((group) => group.id === saved.id ? saved : group)
        : [...current, saved]);
      setEditing(null);
      setFormOpen(false);
      message.success(editing ? '映射组已更新' : '映射组已创建');
    } catch (error: any) {
      message.error(error?.response?.data?.message || '保存映射组失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (group: UpstreamErrorMappingGroup) => {
    try {
      const saved = await upstreamErrorMappingsAPI.toggle(group.id);
      setGroups((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (_error) {
      message.error('切换映射组状态失败');
    }
  };

  const remove = async (group: UpstreamErrorMappingGroup) => {
    const ok = await confirmAction({
      title: '确定要删除这个异常映射组吗？',
      content: group.name,
      okText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    try {
      await upstreamErrorMappingsAPI.delete(group.id);
      setDetailId(null);
      setGroups((current) => current.filter((item) => item.id !== group.id));
      message.success('映射组已删除');
    } catch (_error) {
      message.error('删除映射组失败');
    }
  };

  const actions = (group: UpstreamErrorMappingGroup): SwipeAction[] => [
    { key: 'edit', label: '编辑', icon: <EditOutlined />, tone: 'primary', onAction: () => openEdit(group) },
    {
      key: 'toggle',
      label: group.enabled !== false ? '停用' : '启用',
      icon: <PoweroffOutlined />,
      onAction: () => { void toggle(group); }
    },
    { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => { void remove(group); } }
  ];

  const detail = detailId ? groups.find((group) => group.id === detailId) || null : null;

  return (
    <>
      <MobileToolbar>
        <HudIconButton icon={<ReloadOutlined />} label="重新读取映射组" loading={loading} onClick={() => void loadGroups()} />
        <HudIconButton icon={<PlusOutlined />} label="添加映射组" tone="primary" onClick={openCreate} />
      </MobileToolbar>

      <HudSection title="上游异常映射" code="ROUTE" count={groups.length}>
        {!loaded ? (
          <MobileBoot label="LOADING MAPPINGS" />
        ) : groups.length === 0 ? (
          <EmptySignal
            description="暂无异常映射组"
            action={<HudIconButton icon={<PlusOutlined />} label="添加映射组" tone="primary" showLabel onClick={openCreate} />}
          />
        ) : (
          <MonoList ariaLabel="上游异常映射组">
            {groups.map((group) => {
              const enabled = group.enabled !== false;
              return (
                <SwipeRow
                  key={group.id}
                  ariaLabel={`${group.name} 详情`}
                  actions={actions(group)}
                  onTap={() => setDetailId(group.id)}
                >
                  <span className="mhud-row__main">
                    <span className={`mhud-row__title ${styles.aliasTitle}`}>{group.name}</span>
                    <span className="mhud-row__meta">{upstreamErrorProviderLabel(group.provider)} · {group.rules?.length || 0} 条规则</span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status ${enabled ? 'mhud-tone--ok' : 'mhud-tone--muted'}`}>
                      <span className={`hud-led ${enabled ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />
                      {enabled ? 'ON' : 'OFF'}
                    </span>
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
      </HudSection>

      <DetailSheet
        open={Boolean(detail)}
        onClose={() => setDetailId(null)}
        code="ROUTE"
        title={detail?.name || ''}
        footer={detail ? (
          <>
            <HudIconButton icon={<DeleteOutlined />} label="删除" tone="danger" showLabel onClick={() => { void remove(detail); }} />
            <HudIconButton icon={<PoweroffOutlined />} label={detail.enabled !== false ? '停用' : '启用'} showLabel onClick={() => { void toggle(detail); }} />
            <HudIconButton icon={<EditOutlined />} label="编辑" tone="primary" showLabel onClick={() => openEdit(detail)} />
          </>
        ) : null}
      >
        {detail ? (
          <KeyValue rows={[
            { key: 'provider', label: 'Provider', value: upstreamErrorProviderLabel(detail.provider), mono: false },
            { key: 'rules', label: '规则数', value: detail.rules?.length || 0 },
            { key: 'status', label: '状态', value: detail.enabled !== false ? '启用' : '停用', tone: detail.enabled !== false ? 'ok' as const : 'muted' as const },
            ...(detail.description ? [{ key: 'description', label: '说明', value: detail.description, mono: false }] : [])
          ]} />
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={formOpen}
        onClose={() => setFormOpen(false)}
        code="ROUTE"
        title={editing ? '编辑异常映射组' : '添加异常映射组'}
        destroyOnClose={false}
        footer={(
          <>
            <HudIconButton icon={null} label="取消" showLabel onClick={() => setFormOpen(false)} />
            <HudIconButton icon={<SaveOutlined />} label="保存" tone="primary" showLabel loading={saving} onClick={() => { void save(); }} />
          </>
        )}
      >
        <Form form={form} layout="vertical" className={styles.form}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入映射组名称' }, { max: 80 }]}>
            <Input placeholder="例如：New API 余额不足" />
          </Form.Item>
          <Form.Item name="provider" label="适用 Provider" rules={[{ required: true }]}>
            <Select options={UPSTREAM_ERROR_PROVIDER_OPTIONS} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="description" label="说明" rules={[{ max: 240 }]}>
            <Input.TextArea rows={2} placeholder="说明匹配的上游格式和转换结果" />
          </Form.Item>
          <UpstreamErrorRulesEditor listName="rules" includeGroups={false} />
        </Form>
      </DetailSheet>
    </>
  );
}
