// 三栏布局纯策略：布局模式判定、分隔条拖拽宽度计算与边界钳制、宽度序列化/恢复。
// 与 workbench-state-policy.js 同为无 window 依赖的纯函数模块，供 bun 单测直接验证。

// 与 antd Grid md 断点一致：视口 < 768px 时回退标签页模式，窄屏不塞三栏。
export const COLUMN_LAYOUT_BREAKPOINT = 768;

// mobile 由调用方经 antd Grid.useBreakpoint().md 推导（阈值即 COLUMN_LAYOUT_BREAKPOINT）。
export function resolveLayoutMode(mobile) {
  return mobile ? 'tabs' : 'columns';
}

// 最小栏宽取值须保证 1440×900(应用导航+项目列表占 ~536px,工作台 ~904px)下分隔条仍可拖动:
// 三栏最小值之和 760 + 两条分隔条 12,留出 ~130px 拖拽余量。
export const MIN_COLUMN_WIDTH = Object.freeze({ left: 160, center: 320, right: 280 });
export const DEFAULT_COLUMN_WIDTHS = Object.freeze({ left: 280, right: 420 });
// 每条分隔条的命中宽度（px），计算可用宽度时需从容器宽度中扣除。
export const DIVIDER_WIDTH = 6;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// 分隔条拖动：左分隔条右移加宽左栏，右分隔条右移收窄右栏；中栏永远保住最小宽度。
// availableWidth = 容器宽度 - 分隔条宽度；小于三栏最小宽度之和时退化为各栏最小值。
export function applyDividerDrag(widths, divider, deltaPx, availableWidth) {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(availableWidth)) return widths;
  if (divider === 'left') {
    const max = availableWidth - widths.right - MIN_COLUMN_WIDTH.center;
    return { ...widths, left: clamp(widths.left + deltaPx, MIN_COLUMN_WIDTH.left, max) };
  }
  if (divider === 'right') {
    const max = availableWidth - widths.left - MIN_COLUMN_WIDTH.center;
    return { ...widths, right: clamp(widths.right - deltaPx, MIN_COLUMN_WIDTH.right, max) };
  }
  return widths;
}

// 容器变窄（窗口缩放）时回收宽度：先收窄右栏到最小值，再收窄左栏，中栏不动。
export function clampColumnWidths(widths, availableWidth) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return widths;
  const budget = availableWidth - MIN_COLUMN_WIDTH.center;
  if (widths.left + widths.right <= budget) return widths;
  const right = Math.max(MIN_COLUMN_WIDTH.right, Math.min(widths.right, budget - widths.left));
  const left = Math.max(MIN_COLUMN_WIDTH.left, Math.min(widths.left, budget - right));
  return { left, right };
}

const LAYOUT_SCHEMA_VERSION = 1;

export function serializeColumnWidths(widths) {
  return JSON.stringify({
    v: LAYOUT_SCHEMA_VERSION,
    left: widths.left,
    right: widths.right,
  });
}

// 恢复已持久化的栏宽：版本不符或数值非法时回退默认值；合法值至少钳制到最小宽度
// （上限依赖容器宽度，由组件侧 clampColumnWidths 兜底）。
export function restoreColumnWidths(data) {
  if (!data || data.v !== LAYOUT_SCHEMA_VERSION) return { ...DEFAULT_COLUMN_WIDTHS };
  const left = Number(data.left);
  const right = Number(data.right);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return { ...DEFAULT_COLUMN_WIDTHS };
  return {
    left: Math.max(MIN_COLUMN_WIDTH.left, Math.round(left)),
    right: Math.max(MIN_COLUMN_WIDTH.right, Math.round(right)),
  };
}
