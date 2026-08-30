import { memo } from 'react';
import { Button, Switch, Tooltip } from 'antd';
import {
  ThunderboltFilled,
  StarFilled,
  StarOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import styles from './ModelCapsuleCard.module.css';

export interface ModelCapsuleCardProps {
  modelId: string;
  displayName?: string;
  provider: string;
  accountRef?: string;
  enabled?: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { input?: number; output?: number };
  onToggleEnabled?: (enabled: boolean) => void;
  onSetDefault?: () => void;
  onCopyId?: () => void;
}

export function formatTokensK(n?: number): string {
  if (!n) return '--';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * HarmonyOS 6 风格模型能力胶囊卡片 (ArkUI Capability Capsule Card)
 * 采用 Squircle 超级圆角、高斯通透毛玻璃、流光能力徽标与物理弹性交互
 */
export const ModelCapsuleCard = memo(function ModelCapsuleCard({
  modelId,
  displayName,
  provider,
  enabled = true,
  isDefault = false,
  contextWindow,
  maxOutputTokens,
  onToggleEnabled,
  onSetDefault,
  onCopyId,
}: ModelCapsuleCardProps) {
  return (
    <div className={`${styles.cardContainer} ${enabled ? '' : styles.cardDisabled}`}>
      <div className={styles.cardHeader}>
        <div className={styles.titleArea}>
          <div className={styles.idLine}>
            <span className={styles.modelName}>{displayName || modelId}</span>
            {onCopyId && (
              <button type="button" className={styles.copyBtn} onClick={onCopyId} title="复制模型 ID">
                <CopyOutlined />
              </button>
            )}
          </div>
          <span className={styles.providerBadge}>
            {provider.toUpperCase()}
          </span>
        </div>

        <div className={styles.defaultAction}>
          {onSetDefault && (
            <Tooltip title={isDefault ? '当前会话默认模型' : '设为默认模型'}>
              <Button
                type="text"
                shape="circle"
                size="small"
                className={isDefault ? styles.defaultStarActive : styles.defaultStar}
                onClick={onSetDefault}
                icon={isDefault ? <StarFilled /> : <StarOutlined />}
              />
            </Tooltip>
          )}
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.capsuleTags}>
          {contextWindow ? (
            <span className={styles.metricCapsule}>
              <ThunderboltFilled style={{ color: '#0a59f7' }} /> 上下文 {formatTokensK(contextWindow)}
            </span>
          ) : null}
          {maxOutputTokens ? (
            <span className={styles.metricCapsule}>
              输出上限 {formatTokensK(maxOutputTokens)}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.cardFooter}>
        <div className={styles.statusState}>
          {enabled ? (
            <span className={styles.statusOnline}>
              <CheckCircleOutlined /> 已启用
            </span>
          ) : (
            <span className={styles.statusOffline}>
              <CloseCircleOutlined /> 已停用
            </span>
          )}
        </div>
        {onToggleEnabled && (
          <Switch
            checked={enabled}
            onChange={onToggleEnabled}
            size="small"
          />
        )}
      </div>
    </div>
  );
});

export default ModelCapsuleCard;
