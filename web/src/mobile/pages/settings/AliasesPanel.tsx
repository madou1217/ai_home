import { DeleteOutlined, EditOutlined, PlusOutlined, PoweroffOutlined, ReloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import {
  formatAliasScope,
  formatAliasTargetProvider,
  groupModelAliases,
  type AliasGroup
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
  const [editing, setEditing] = useState<AliasGroup | null>(null);

  const groups = groupModelAliases(aliases.sortedAliases);
  const detail = detailId ? groups.find((item) => item.alias === detailId) || null : null;

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (group: AliasGroup) => {
    setDetailId(null);
    // 编辑聚合行：表单按整组回填多选值，保存时服务端原子替换这组记录。
    setEditing(group);
    setFormOpen(true);
  };

  const confirmDelete = async (group: AliasGroup) => {
    const ok = await confirmAction({
      title: `确定要删除这个别名的全部 ${group.records.length} 条记录吗？`,
      content: group.alias,
      okText: '确定',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    setDetailId(null);
    await aliases.deleteAliases(group.records.map((record) => record.id));
  };

  const targetText = (record: ModelAlias) => {
    const label = aliases.findModelLabel(record.target);
    return label ? `${record.target} (${label})` : record.target;
  };

  const toggleGroup = async (group: AliasGroup) => {
    const anyEnabled = group.records.some((record) => record.enabled !== false);
    for (const record of group.records) {
      if ((record.enabled !== false) === anyEnabled) await aliases.toggleAlias(record.id);
    }
  };

  const rowActions = (group: AliasGroup): SwipeAction[] => [
    { key: 'edit', label: '编辑', icon: <EditOutlined />, tone: 'primary', onAction: () => openEdit(group) },
    {
      key: 'toggle',
      label: group.enabled ? '禁用' : '启用',
      icon: <PoweroffOutlined />,
      onAction: () => toggleGroup(group)
    },
    { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => confirmDelete(group) }
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

      <HudSection title="模型别名" code="ALIAS" count={groups.length}>
        {!aliases.loaded ? (
          <MobileBoot label="LOADING ALIASES" />
        ) : groups.length === 0 ? (
          <EmptySignal
            description="暂无模型别名"
            action={<HudIconButton icon={<PlusOutlined />} label="添加别名" tone="primary" showLabel onClick={openAdd} />}
          />
        ) : (
          <MonoList ariaLabel="模型别名">
            {groups.map((group) => {
              const enabled = group.enabled;
              return (
                <SwipeRow
                  key={group.alias}
                  ariaLabel={`${group.alias} 详情`}
                  actions={rowActions(group)}
                  onTap={() => setDetailId(group.alias)}
                >
                  <span className="mhud-row__main">
                    <span className={`mhud-row__title ${styles.aliasTitle}`}>{group.alias}</span>
                    <span className="mhud-row__meta">
                      {group.records.length > 1
                        ? `→ ${group.records.length} 条记录`
                        : `→ ${targetText(group.records[0])}`}
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status ${enabled ? 'mhud-tone--ok' : 'mhud-tone--muted'}`}>
                      <span className={`hud-led ${enabled ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />
                      {enabled ? 'ON' : 'OFF'}
                    </span>
                    <span className={styles.aliasPriority}>P{Number(group.records[0]?.priority) || 0}</span>
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
              label={detail.enabled ? '禁用' : '启用'}
              showLabel
              onClick={() => toggleGroup(detail)}
            />
            <HudIconButton icon={<EditOutlined />} label="编辑" tone="primary" showLabel onClick={() => openEdit(detail)} />
          </>
        ) : null}
      >
        {detail ? (
          <KeyValue
            rows={[
              { key: 'alias', label: '别名', value: detail.alias, tone: 'info' },
              ...detail.records.map((record) => ({
                key: `target:${record.id}`,
                label: '目标模型',
                value: `${targetText(record)} ← ${formatAliasTargetProvider(record.targetProvider)}`
              })),
              { key: 'count', label: '记录数', value: detail.records.length },
              { key: 'priority', label: '优先级', value: Number(detail.records[0]?.priority) || 0 },
              { key: 'scope', label: '请求范围', value: formatAliasScope(detail.provider), mono: false },
              ...(detail.description ? [{ key: 'desc', label: '备注', value: detail.description, mono: false }] : []),
              {
                key: 'status',
                label: '状态',
                value: detail.enabled ? '启用' : '禁用',
                tone: detail.enabled ? 'ok' as const : 'muted' as const
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
        onClose={() => setFormOpen(false)}
        onSave={aliases.saveAlias}
      />
    </>
  );
}
