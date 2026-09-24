import { CheckCircleOutlined, CloseCircleOutlined, CopyOutlined, StarOutlined } from '@ant-design/icons';
import { DetailSheet, HudIconButton, KeyValue } from '@/mobile/ui';
import { providerNames } from '@/components/chat/ProviderIcon';
import type { ManagedOpenAIModelItem } from '@/types';
import styles from '../MobileAccountModels.module.css';

interface Props {
  model: ManagedOpenAIModelItem | null;
  displayLabel: string;
  onClose: () => void;
  onToggleEnabled: (model: ManagedOpenAIModelItem, enabled: boolean) => void;
  onSetDefault: (model: ManagedOpenAIModelItem) => void;
  onCopyId: (modelId: string) => void;
}

/** 单个账号模型的详情与操作（启用 / 停用、设为默认、复制 ID），同桌面模型卡片的三项操作。 */
export default function AccountModelSheet({ model, displayLabel, onClose, onToggleEnabled, onSetDefault, onCopyId }: Props) {
  if (!model) {
    return <DetailSheet open={false} onClose={onClose} title="">{null}</DetailSheet>;
  }
  const enabled = model.enabled !== false;
  const isDefault = Boolean(model.defaultModel);
  return (
    <DetailSheet
      open
      onClose={onClose}
      code="MODEL"
      title={displayLabel || model.id}
      footer={(
        <div className={styles.sheetFooter}>
          <HudIconButton
            icon={enabled ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
            label={enabled ? '停用' : '启用'}
            showLabel
            onClick={() => onToggleEnabled(model, !enabled)}
          />
          <HudIconButton
            icon={<StarOutlined />}
            label={isDefault ? '默认模型' : '设为默认'}
            showLabel
            disabled={isDefault || !enabled}
            onClick={() => onSetDefault(model)}
          />
          <HudIconButton
            icon={<CopyOutlined />}
            label="复制 ID"
            showLabel
            onClick={() => onCopyId(model.id)}
          />
        </div>
      )}
    >
      <KeyValue
        rows={[
          { key: 'id', label: '模型 ID', value: model.id },
          ...(displayLabel ? [{ key: 'label', label: '显示名', value: displayLabel, mono: false }] : []),
          { key: 'provider', label: 'Provider', value: providerNames[model.provider] || model.provider, mono: false },
          { key: 'enabled', label: '状态', value: enabled ? '启用' : '停用', tone: enabled ? 'ok' : 'muted', mono: false },
          { key: 'default', label: '默认模型', value: isDefault ? '是' : '否', tone: isDefault ? 'info' : undefined, mono: false },
          { key: 'manual', label: '手动补充', value: model.manual ? '是' : '否', mono: false }
        ]}
      />
    </DetailSheet>
  );
}
