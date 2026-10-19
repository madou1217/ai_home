/**
 * 模型价格展示的纯函数（单位：美元 / 每百万 token）。
 * 无 React、无路径别名依赖，便于组件与 node:test 直接复用。
 */

export const PRICE_DIMENSIONS = [
  { key: 'input', label: '入' },
  { key: 'output', label: '出' },
  { key: 'cacheRead', label: '缓读' },
  { key: 'cacheWrite', label: '缓写' }
] as const;

export type PriceDimensionKey = (typeof PRICE_DIMENSIONS)[number]['key'];
export type ModelPriceMap = Partial<Record<PriceDimensionKey, number>>;

export interface ModelPriceCell {
  key: PriceDimensionKey;
  label: string;
  /** 当前生效价（自定义价优先）。 */
  value: number;
  /** models.dev 原价；命中自定义覆盖时保留用于划线展示。 */
  base?: number;
  overridden: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 每百万 token 美元 → 展示串（自动缩量，避免 0.000003 这种长尾）。 */
export function formatPricePerM(n: number): string {
  if (!Number.isFinite(n)) return '--';
  if (n === 0) return '0';
  if (n >= 10) return n.toFixed(1);
  if (n >= 0.01) return n.toFixed(2);
  return Number(n.toPrecision(2)).toString();
}

/**
 * 合并 models.dev 原价与账号自定义价，返回可见的价格维度。
 * 自定义价优先并标记 overridden；未覆盖维度回落原价；都没有的维度不输出。
 */
export function resolveModelPriceCells(
  base?: ModelPriceMap | null,
  custom?: ModelPriceMap | null
): ModelPriceCell[] {
  const cells: ModelPriceCell[] = [];
  PRICE_DIMENSIONS.forEach(({ key, label }) => {
    const customValue = custom ? custom[key] : undefined;
    const baseValue = base ? base[key] : undefined;
    if (isFiniteNumber(customValue)) {
      cells.push({
        key,
        label,
        value: customValue,
        ...(isFiniteNumber(baseValue) ? { base: baseValue } : {}),
        overridden: true
      });
      return;
    }
    if (isFiniteNumber(baseValue)) {
      cells.push({ key, label, value: baseValue, overridden: false });
    }
  });
  return cells;
}

/** 是否存在任意有效自定义价（空对象 / 全非法值均视为未设置）。 */
export function hasCustomPricingValues(custom?: ModelPriceMap | null): boolean {
  if (!custom) return false;
  return PRICE_DIMENSIONS.some(({ key }) => isFiniteNumber(custom[key]));
}
