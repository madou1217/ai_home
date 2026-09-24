import { DeleteOutlined, EditOutlined, PlusOutlined, PoweroffOutlined, ReloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import {
  formatAliasScope,
  formatAliasTargetProvider
} from '@/features/model-aliases/model-alias-presentation';
import { useModelAliases } from '@/features/model-aliases/use-model-aliases';
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
import type { ModelAlias } from '@/services/api';
import { confirmAction } from '@/utils/confirm-action';
import AliasFormSheet from './AliasFormSheet';
import styles from './MobileSettings.module.css';

/**
 * 模型别名分区：列表（左滑 编辑 / 启停 / 删除）+ 点按详情 + 表单抽屉。
 * 数据与动作全部来自 useModelAliases（modelAliasesAPI / modelsAPI.listCatalog），与桌面表格同源。
 */
export default function AliasesPanel() {
  const aliases = useModelAliases();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelAlias | null>(null);

  const detail = detailId ? aliases.sortedAliases.find((item) => item.id === detailId) || null : null;

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (record: ModelAlias) => {
    setDetailId(null);
    setEditing(record);
    setFormOpen(true);
  };

  const confirmDelete = async (record: ModelAlias) => {
    const ok = await confirmAction({
      title: '确定要删除这个别名吗？',
      content: record.alias,
      okText: '确定',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    setDetailId(null);
    await aliases.deleteAlias(record.id);
  };

  const targetText = (record: ModelAlias) => {
    const label = aliases.findModelLabel(record.target);
    return label ? `${record.target} (${label})` : record.target;
  };

  const rowActions = (record: ModelAlias): SwipeAction[] => [
    { key: 'edit', label: '编辑', icon: <EditOutlined />, tone: 'primary', onAction: () => openEdit(record) },
    {
      key: 'toggle',
      label: record.enabled !== false ? '禁用' : '启用',
      icon: <PoweroffOutlined />,
      onAction: () => aliases.toggleAlias(record.id)
    },
    { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => confirmDelete(record) }
  ];

  return (
    <>
      <MobileToolbar>
        <HudIconButton
          icon={<ReloadOutlined />}
          label="重新读取缓存"
          loading={aliases.modelsLoading}
          onClick={() => aliases.fetchModels(true)}
        />
        <HudIconButton icon={<PlusOutlined />} label="添加别名" tone="primary" onClick={openAdd} />
      </MobileToolbar>

      <HudSection title="模型别名" code="ALIAS" count={aliases.sortedAliases.length}>
        {!aliases.loaded ? (
          <MobileBoot label="LOADING ALIASES" />
        ) : aliases.sortedAliases.length === 0 ? (
          <EmptySignal
            description="暂无模型别名"
            action={<HudIconButton icon={<PlusOutlined />} label="添加别名" tone="primary" showLabel onClick={openAdd} />}
          />
        ) : (
          <MonoList ariaLabel="模型别名">
            {aliases.sortedAliases.map((record) => {
              const enabled = record.enabled !== false;
              return (
                <SwipeRow
                  key={record.id}
                  ariaLabel={`${record.alias} 详情`}
                  actions={rowActions(record)}
                  onTap={() => setDetailId(record.id)}
                >
                  <span className="mhud-row__main">
                    <span className={`mhud-row__title ${styles.aliasTitle}`}>{record.alias}</span>
                    <span className="mhud-row__meta">→ {targetText(record)}</span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status ${enabled ? 'mhud-tone--ok' : 'mhud-tone--muted'}`}>
                      <span className={`hud-led ${enabled ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />
                      {enabled ? 'ON' : 'OFF'}
                    </span>
                    <span className={styles.aliasPriority}>P{Number(record.priority) || 0}</span>
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
        code="ALIAS"
        title={detail?.alias || ''}
        footer={detail ? (
          <>
            <HudIconButton icon={<DeleteOutlined />} label="删除" tone="danger" showLabel onClick={() => confirmDelete(detail)} />
            <HudIconButton
              icon={<PoweroffOutlined />}
              label={detail.enabled !== false ? '禁用' : '启用'}
              showLabel
              onClick={() => aliases.toggleAlias(detail.id)}
            />
            <HudIconButton icon={<EditOutlined />} label="编辑" tone="primary" showLabel onClick={() => openEdit(detail)} />
          </>
        ) : null}
      >
        {detail ? (
          <KeyValue
            rows={[
              { key: 'alias', label: '别名', value: detail.alias, tone: 'info' },
              { key: 'target', label: '目标模型', value: targetText(detail) },
              { key: 'priority', label: '优先级', value: Number(detail.priority) || 0 },
              { key: 'scope', label: '请求范围', value: formatAliasScope(detail.provider), mono: false },
              { key: 'targetProvider', label: '目标供应商', value: formatAliasTargetProvider(detail.targetProvider), mono: false },
              ...(detail.description ? [{ key: 'desc', label: '备注', value: detail.description, mono: false }] : []),
              {
                key: 'status',
                label: '状态',
                value: detail.enabled !== false ? '启用' : '禁用',
                tone: detail.enabled !== false ? 'ok' as const : 'muted' as const
              }
            ]}
          />
        ) : null}
      </DetailSheet>

      <AliasFormSheet
        open={formOpen}
        editing={editing}
        modelsByProvider={aliases.modelsByProvider}
        modelsLoading={aliases.modelsLoading}
        getModelLabel={aliases.getModelLabel}
        providerHasModel={aliases.providerHasModel}
        onClose={() => setFormOpen(false)}
        onSave={aliases.saveAlias}
      />
    </>
  );
}
