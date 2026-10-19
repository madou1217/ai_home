import { memo } from 'react';
import { Button, Switch, Tooltip } from 'antd';
import {
  ThunderboltFilled,
  StarFilled,
  StarOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  PayCircleOutlined,
  EditOutlined,
} from '@ant-design/icons';
import {
  formatPricePerM,
  hasCustomPricingValues,
  resolveModelPriceCells,
  type ModelPriceCell
} from '@/utils/model-price';
import styles from './ModelCapsuleCard.module.css';

function PriceValue({ cell }: { cell: ModelPriceCell }) {
  return (
    <span className={styles.priceValue}>
      <span className={styles.priceKind}>{cell.label}</span>
      <span className={styles.priceAmount}>${formatPricePerM(cell.value)}</span>
      {cell.overridden && cell.base !== undefined ? (
        <span className={styles.priceBase}>${formatPricePerM(cell.base)}</span>
      ) : null}
    </span>
  );
}

export interface ModelCapsuleCardProps {
  modelId: string;
  displayName?: string;
  provider: string;
  accountRef?: string;
  enabled?: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** models.dev 原价（每百万 token 美元），来自 metadata.cost。 */
  pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** 账号自定义价覆盖（同单位）；有值的维度显示为生效价，原价划线。 */
  customPricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  onEditPricing?: () => void;
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
 * 模型能力卡片：HUD 小切角面板 + 发丝线描边，模型 ID / 能力标签 / 启用状态
 */
export const ModelCapsuleCard = memo(function ModelCapsuleCard({
  modelId,
  displayName,
  provider,
  enabled = true,
  isDefault = false,
  contextWindow,
  maxOutputTokens,
  pricing,
  customPricing,
  onEditPricing,
  onToggleEnabled,
  onSetDefault,
  onCopyId,
}: ModelCapsuleCardProps) {
  const priceCells = resolveModelPriceCells(pricing, customPricing);
  const pricingTitle = priceCells
    .map((cell) => `${cell.label} $${formatPricePerM(cell.value)}${cell.overridden && cell.base !== undefined ? `（原价 $${formatPricePerM(cell.base)}）` : ''}`)
    .join(' · ');
  const pricingRow = priceCells.length > 0 ? (
    <Tooltip title={`${pricingTitle}${onEditPricing ? ' · 点击编辑价格（每百万 token 美元）' : ''}`}>
      <button
        type="button"
        className={styles.pricingCapsule}
        onClick={onEditPricing}
        disabled={!onEditPricing}
      >
        <PayCircleOutlined className={styles.metricIcon} />
        <span className={styles.pricingPair}>
          {priceCells.map((cell) => <PriceValue key={cell.key} cell={cell} />)}
        </span>
        {hasCustomPricingValues(customPricing) ? (
          <EditOutlined className={styles.pricingEditIcon} />
        ) : null}
      </button>
    </Tooltip>
  ) : onEditPricing ? (
    // 目录里没有同模型价格（或 models.dev 未收录）时，仍然保留定价入口：
    // 否则「价格未知」的模型恰好没有任何地方能设置自定义价。
    <Tooltip title="价格未知 · 点击设置自定义价格（每百万 token 美元）">
      <button
        type="button"
        className={`${styles.pricingCapsule} ${styles.pricingUnknown}`}
        onClick={onEditPricing}
      >
        <PayCircleOutlined className={styles.metricIcon} />
        <span>价格未知</span>
        <EditOutlined className={styles.pricingEditIcon} />
      </button>
    </Tooltip>
  ) : null;
  return (
    <div className={`${styles.cardContainer} hud-panel hud-panel--sm ${enabled ? '' : styles.cardDisabled}`}>
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
              <ThunderboltFilled className={styles.metricIcon} /> 上下文 {formatTokensK(contextWindow)}
            </span>
          ) : null}
          {maxOutputTokens ? (
            <span className={styles.metricCapsule}>
              输出上限 {formatTokensK(maxOutputTokens)}
            </span>
          ) : null}
          {pricingRow}
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
