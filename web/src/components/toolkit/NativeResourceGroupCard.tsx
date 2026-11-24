import type { ReactNode } from 'react';
import { Popconfirm, Tag, Tooltip } from 'antd';
import {
  DeleteOutlined,
  InfoCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import type { NativeResourceAction, NativeResourceManagedRecord } from '@/types';
import {
  KIND_LABELS,
  isEnabled,
  resourceKey,
  resourceOwner,
  resourceSummary
} from './native-resource-grouping';
import type { NativeResourceGroup } from './native-resource-grouping';
import './ToolkitPanels.css';

export type ManagedNativeAction = Extract<NativeResourceAction, 'enable' | 'disable' | 'remove' | 'test'>;

export function nativeActionTargets(
  group: NativeResourceGroup,
  action: ManagedNativeAction
): NativeResourceManagedRecord[] {
  if (action === 'enable') return group.records.filter((record) => !isEnabled(record));
  if (action === 'disable') return group.records.filter(isEnabled);
  return group.records;
}

export function nativeActionLabel(action: ManagedNativeAction, count: number): string {
  const prefix = count > 1 ? '全部' : '';
  if (action === 'enable') return `${prefix}启用`;
  if (action === 'disable') return `${prefix}停用`;
  return `${prefix}移除`;
}

interface NativeResourceGroupCardProps {
  group: NativeResourceGroup;
  icon: ReactNode;
  busy: string;
  bulkBusy: string;
  onOpenDetail: (group: NativeResourceGroup) => void;
  onBulkAction: (group: NativeResourceGroup, action: ManagedNativeAction) => void;
}

export default function NativeResourceGroupCard({
  group,
  icon,
  busy,
  bulkBusy,
  onOpenDetail,
  onBulkAction
}: NativeResourceGroupCardProps) {
  const enabledCount = group.records.filter(isEnabled).length;
  const totalCount = group.records.length;
  const allEnabled = enabledCount === totalCount;
  const multi = totalCount > 1;
  const summary = group.description
    || (group.kind === 'mcp'
      ? Array.from(new Set(group.records.map(resourceSummary))).join(' · ')
      : '未提供描述');
  const isBusyThis = bulkBusy === group.key;

  const statusTag = enabledCount === totalCount
    ? <SettingStatusTag status="saved" label="已启用" compact />
    : enabledCount === 0
      ? <SettingStatusTag status="unset" label="未启用" compact />
      : <SettingStatusTag status="dirty" label={`部分启用 ${enabledCount}/${totalCount}`} compact />;

  return (
    <article className="toolkit-native-card hud-panel hud-panel--sm">
      <div>
        <div className="toolkit-native-card-head">
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div className="toolkit-native-card-title">
              <span className="toolkit-client-glyph" aria-hidden="true">{icon}</span>
              <span className="toolkit-native-card-name" title={group.id}>{group.id}</span>
            </div>
            <div className="toolkit-native-card-meta">
              {statusTag}
              <Tag>{KIND_LABELS[group.kind]}</Tag>
              {group.version ? <Tag>{group.version}</Tag> : null}
            </div>
          </div>
          <Button size="small" icon={<InfoCircleOutlined />} onClick={() => onOpenDetail(group)}>
            详情
          </Button>
        </div>

        <Tooltip title={summary}>
          <p className="toolkit-native-card-summary" style={{ marginTop: 10 }}>{summary}</p>
        </Tooltip>

        <div className="toolkit-native-host-list" style={{ marginTop: 10 }}>
          {group.records.map((record) => {
            const enabled = isEnabled(record);
            return (
              <Tag key={resourceKey(record)} color={enabled ? 'success' : 'default'}>
                {resourceOwner(record)} · {enabled ? '已启用' : '未启用'}
              </Tag>
            );
          })}
        </div>
      </div>

      <div className="toolkit-native-card-actions">
        {!allEnabled ? (
          <Button
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={Boolean(bulkBusy)}
            loading={isBusyThis}
            onClick={() => onBulkAction(group, 'enable')}
          >
            {nativeActionLabel('enable', nativeActionTargets(group, 'enable').length)}
          </Button>
        ) : null}
        {enabledCount ? (
          <Button
            size="small"
            icon={<PauseCircleOutlined />}
            disabled={Boolean(bulkBusy)}
            loading={isBusyThis}
            onClick={() => onBulkAction(group, 'disable')}
          >
            {nativeActionLabel('disable', nativeActionTargets(group, 'disable').length)}
          </Button>
        ) : null}
        <Popconfirm
          title={`移除 ${group.id} 的全部 ${totalCount} 个宿主投影？`}
          description={multi ? '将逐个宿主移除，如部分失败会保留结果并提示。' : undefined}
          okText="移除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onBulkAction(group, 'remove')}
        >
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={Boolean(busy) || Boolean(bulkBusy)}
          >
            {nativeActionLabel('remove', totalCount)}
          </Button>
        </Popconfirm>
      </div>
    </article>
  );
}
