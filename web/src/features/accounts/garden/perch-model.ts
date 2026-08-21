import type { AccountTokenUsage } from '@/types';
import {
  TOKEN_CHART_BAR_OFFSET,
  TOKEN_CHART_BAR_WIDTH,
  TOKEN_CHART_BASELINE,
  TOKEN_CHART_SLOT_WIDTH,
  buildTokenUsageMetrics,
  getTokenUsageBarHeight
} from '@/components/account/token-usage-periods';

/** 桌面槽宽比图表原始槽窄，SVG 的 meet 缩放要一起折算。 */
const GARDEN_DESKTOP_SLOT_WIDTH = 46;
const GARDEN_DESKTOP_WIDTH_GUTTER = 2;
const TOKEN_CHART_VIEW_HEIGHT = 38;

/** 一个落脚点就是一根真实的 Token 柱子；日/周/月/总会被折叠，所以数量是 1~4 根。 */
export interface GardenPerch {
  /** 柱子对应的统计窗口（day/week/month/total）——落脚点的稳定身份。 */
  metricKey: string;
  /** 柱子在当前图表里的序号；折叠后会变，不能当身份用。 */
  metricIndex: number;
  /** 柱心横坐标，占图表宽度的百分比。 */
  xPercent: number;
  /** 桌面柱顶纵坐标（已折算 SVG meet 缩放）。 */
  y: number;
  /** 移动端柱顶纵坐标（原始图表坐标）。 */
  mobileY: number;
  /** 柱高，用来让茎长跟着柱子走而不是写死。 */
  barHeight: number;
}

export interface GardenPerchLayout {
  columns: number;
  perches: GardenPerch[];
}

/**
 * 把当前这一格真实画出来的柱子翻译成落脚点。
 * 不伪造柱子：柱子折叠成一根时就只有一个落脚点，花只能原地待着。
 */
export function buildGardenPerches(usage: AccountTokenUsage): GardenPerchLayout {
  const metrics = buildTokenUsageMetrics(usage);
  const columns = metrics.length;
  const chartWidth = Math.max(1, columns * TOKEN_CHART_SLOT_WIDTH);
  const desktopChartWidth = columns * GARDEN_DESKTOP_SLOT_WIDTH + GARDEN_DESKTOP_WIDTH_GUTTER;
  const desktopScale = Math.min(1, desktopChartWidth / chartWidth);
  const desktopVerticalInset = (
    TOKEN_CHART_VIEW_HEIGHT - TOKEN_CHART_VIEW_HEIGHT * desktopScale
  ) / 2;
  const values = metrics.flatMap(({ value }) => (value === null ? [] : [value]));
  const maximum = Math.max(0, ...values);

  return {
    columns,
    perches: metrics.map((metric, metricIndex) => {
      const barHeight = getTokenUsageBarHeight(metric.value, maximum);
      const anchorX = TOKEN_CHART_BAR_OFFSET
        + metricIndex * TOKEN_CHART_SLOT_WIDTH
        + TOKEN_CHART_BAR_WIDTH / 2;
      const mobileY = TOKEN_CHART_BASELINE - barHeight;
      return {
        metricKey: metric.key,
        metricIndex,
        xPercent: (anchorX / chartWidth) * 100,
        // SVG 默认 preserveAspectRatio="xMidYMid meet"；桌面槽会同步缩放 Y 轴并垂直居中。
        y: desktopVerticalInset + mobileY * desktopScale,
        mobileY,
        barHeight
      };
    })
  };
}

/**
 * 落脚点在两次渲染之间可能整根消失（用量变化触发折叠），此时必须重新落座而不是悬空。
 * 优先认 metricKey——柱子换了序号但还是同一个窗口时，花不该被判定为"脚下没了"。
 */
export function resolvePerchIndex(
  perches: GardenPerch[],
  currentMetricKey: string,
  fallbackIndex = 0
): number {
  if (perches.length === 0) return -1;
  const byKey = perches.findIndex((perch) => perch.metricKey === currentMetricKey);
  if (byKey >= 0) return byKey;
  return Math.min(Math.max(0, fallbackIndex), perches.length - 1);
}
