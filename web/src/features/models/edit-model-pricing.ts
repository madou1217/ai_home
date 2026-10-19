import type { CustomPricing, ManagedOpenAIModelItem } from '@/types';
import {
  formatPricePerM,
  hasCustomPricingValues,
  resolveModelPriceCells
} from '@/utils/model-price';

/**
 * 模型价格一览串（每百万 token 美元）：
 * 自定义价生效维度显示「入 $1.00」并覆盖原价，其余维度用 models.dev 原价。
 * 没有任何可展示价格时返回 '--'。
 */
export function formatModelPrice(model: Pick<ManagedOpenAIModelItem, 'metadata' | 'customPricing'>): string {
  const cells = resolveModelPriceCells(model.metadata?.cost, model.customPricing);
  return cells.length
    ? cells.map((cell) => `${cell.label} $${formatPricePerM(cell.value)}`).join(' · ')
    : '--';
}

/** 是否存在有效的账号自定义价（用于详情页标记「已覆盖原价」）。 */
export function hasCustomModelPricing(model: Pick<ManagedOpenAIModelItem, 'customPricing'>): boolean {
  return hasCustomPricingValues(model.customPricing);
}

/**
 * 编辑值组装：全空 → null（清空自定义价、恢复原价）；否则只提交已填写的维度。
 * 与桌面 EditModelPricingModal 共用同一口径（移动端复用）。
 */
export function buildCustomPricingPayload(values: {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}): CustomPricing | null {
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  const filled: CustomPricing = {};
  let hasValue = false;
  keys.forEach((key) => {
    const value = values[key];
    if (value === undefined || value === null) return;
    filled[key] = value;
    hasValue = true;
  });
  return hasValue ? filled : null;
}
