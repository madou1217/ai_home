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
// 折叠态栏宽：收成 36px 栏头条（chevron + 纵向标签），与栏工具行高度一致。
export const COLLAPSED_COLUMN_WIDTH = 36;
// 左右栏默认折叠（右栏=终端/变更/浏览器，左栏=文件预览宿主），用户展开后按持久化恢复。
export const DEFAULT_COLUMN_COLLAPSED = Object.freeze({ left: true, right: true });

// 栏可见性阈值（容器宽度 px）：舒适断面按 左240 + 中460 + 右340 推导。
// >= 舒适阈值三栏正常；>= 侧栏阈值时右栏退出网格、中栏吃满；再低则左右栏都退出，只留中栏会话。
// 侧栏阈值 900：左栏 tab（文件/变更/Sessions）至少 ~240px 才不重叠，160px 最小宽度的左栏无使用价值，
// 故 700~899 区间不再保留左栏（1280×800 视口下工作台容器 ~744px，左右栏都转 overlay）。
export const COLUMN_COMFORTABLE_WIDTH = 1040;
export const COLUMN_SIDEBAR_WIDTH = 900;

// 容器宽度 -> 栏可见性。被隐藏的栏由组件层保持挂载（CSS 显隐 / overlay），终端 PTY 不回收。
// 宽度未知（非数值 / <= 0，如首帧未测量）时按三栏全显兜底，避免误隐藏。
export function resolveColumnVisibility(containerWidth) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return { left: true, right: true };
  if (containerWidth >= COLUMN_COMFORTABLE_WIDTH) return { left: true, right: true };
  if (containerWidth >= COLUMN_SIDEBAR_WIDTH) return { left: true, right: false };
  return { left: false, right: false };
}

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
// 可选 visibility（resolveColumnVisibility 的结果）：被隐藏的栏不占预算、也不被改写，
// 保留其期望值，待栏恢复可见时再按新预算钳制——恢复时不会因隐藏期被误压。
// 不传 visibility 等价于两栏全可见，行为与旧版一致。
export function clampColumnWidths(widths, availableWidth, visibility) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return widths;
  const vis = visibility || { left: true, right: true };
  const budget = availableWidth - MIN_COLUMN_WIDTH.center;
  const leftWanted = vis.left ? widths.left : 0;
  const rightWanted = vis.right ? widths.right : 0;
  if (leftWanted + rightWanted <= budget) return widths;
  const right = vis.right
    ? Math.max(MIN_COLUMN_WIDTH.right, Math.min(widths.right, budget - leftWanted))
    : widths.right;
  // 左栏钳制基于已收窄的右栏（与旧版两栏全可见时的语义一致）。
  const left = vis.left
    ? Math.max(MIN_COLUMN_WIDTH.left, Math.min(widths.left, budget - (vis.right ? right : 0)))
    : widths.left;
  return { left, right };
}

const LAYOUT_SCHEMA_VERSION = 2;

export function serializeColumnLayout(layout) {
  return JSON.stringify({
    v: LAYOUT_SCHEMA_VERSION,
    left: layout.widths.left,
    right: layout.widths.right,
    collapsedLeft: layout.collapsed.left,
    collapsedRight: layout.collapsed.right,
  });
}

// 恢复已持久化的栏布局：版本不符或数值非法时回退默认值；合法宽度至少钳制到最小宽度
// （上限依赖容器宽度，由组件侧 clampColumnWidths 兜底）。v1 旧记录只含宽度，
// 折叠态缺失时按默认折叠处理（DEFAULT_COLUMN_COLLAPSED）。
export function restoreColumnLayout(data) {
  if (!data || (data.v !== LAYOUT_SCHEMA_VERSION && data.v !== 1)) {
    return { widths: { ...DEFAULT_COLUMN_WIDTHS }, collapsed: { ...DEFAULT_COLUMN_COLLAPSED } };
  }
  const left = Number(data.left);
  const right = Number(data.right);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { widths: { ...DEFAULT_COLUMN_WIDTHS }, collapsed: { ...DEFAULT_COLUMN_COLLAPSED } };
  }
  return {
    widths: {
      left: Math.max(MIN_COLUMN_WIDTH.left, Math.round(left)),
      right: Math.max(MIN_COLUMN_WIDTH.right, Math.round(right)),
    },
    collapsed: {
      left: typeof data.collapsedLeft === 'boolean' ? data.collapsedLeft : DEFAULT_COLUMN_COLLAPSED.left,
      right: typeof data.collapsedRight === 'boolean' ? data.collapsedRight : DEFAULT_COLUMN_COLLAPSED.right,
    },
  };
}
