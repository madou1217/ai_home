import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDividerDrag,
  clampColumnWidths,
  COLLAPSED_COLUMN_WIDTH,
  COLUMN_COMFORTABLE_WIDTH,
  COLUMN_LAYOUT_BREAKPOINT,
  COLUMN_SIDEBAR_WIDTH,
  DEFAULT_COLUMN_COLLAPSED,
  DEFAULT_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  resolveColumnVisibility,
  resolveLayoutMode,
  restoreColumnLayout,
  serializeColumnLayout,
} from './workbench-layout.ts';
import { loadColumnLayout, saveColumnLayout } from './workbench-layout-persistence.ts';

// 持久化模块在函数调用时读取 window.localStorage，测试前注入内存版假环境。
const storageData = new Map<string, string>();
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = {
  getItem: (key: string) => (storageData.has(key) ? storageData.get(key)! : null),
  setItem: (key: string, value: string) => { storageData.set(key, String(value)); },
  removeItem: (key: string) => { storageData.delete(key); },
};

test('resolveLayoutMode 移动端回退标签页、PC 端启用三栏', () => {
  assert.equal(resolveLayoutMode(true), 'tabs');
  assert.equal(resolveLayoutMode(false), 'columns');
  // 断点与 antd Grid md 一致：< 768px 视为移动端。
  assert.equal(COLUMN_LAYOUT_BREAKPOINT, 768);
});

test('列可见性阈值取值固定（舒适 1040 / 侧栏 900）', () => {
  assert.equal(COLUMN_COMFORTABLE_WIDTH, 1040);
  assert.equal(COLUMN_SIDEBAR_WIDTH, 900);
});

test('resolveColumnVisibility 舒适区间三栏全显', () => {
  assert.deepEqual(resolveColumnVisibility(1280), { left: true, right: true });
  // 边界：恰好达到舒适阈值即三栏。
  assert.deepEqual(resolveColumnVisibility(COLUMN_COMFORTABLE_WIDTH), { left: true, right: true });
});

test('resolveColumnVisibility 次级区间隐藏右栏、保留左栏', () => {
  // 边界：舒适阈值 -1 落入次级区间。
  assert.deepEqual(resolveColumnVisibility(COLUMN_COMFORTABLE_WIDTH - 1), { left: true, right: false });
  assert.deepEqual(resolveColumnVisibility(960), { left: true, right: false });
  // 边界：恰好达到侧栏阈值仍保留左栏。
  assert.deepEqual(resolveColumnVisibility(COLUMN_SIDEBAR_WIDTH), { left: true, right: false });
});

test('resolveColumnVisibility 低于侧栏阈值只剩中栏', () => {
  // 边界：侧栏阈值 -1 左右栏全隐藏（1280×800 视口下工作台容器 ~744px 即此区间：
  // 160px 最小宽度的左栏 tab 互相重叠，无使用价值）。
  assert.deepEqual(resolveColumnVisibility(COLUMN_SIDEBAR_WIDTH - 1), { left: false, right: false });
  assert.deepEqual(resolveColumnVisibility(744), { left: false, right: false });
  assert.deepEqual(resolveColumnVisibility(1), { left: false, right: false });
});

test('resolveColumnVisibility 宽度未知（非数值/<=0）按三栏全显兜底', () => {
  assert.deepEqual(resolveColumnVisibility(0), { left: true, right: true });
  assert.deepEqual(resolveColumnVisibility(-10), { left: true, right: true });
  assert.deepEqual(resolveColumnVisibility(Number.NaN), { left: true, right: true });
  assert.deepEqual(resolveColumnVisibility(Number.POSITIVE_INFINITY), { left: true, right: true });
});

test('applyDividerDrag 左分隔条右移加宽左栏', () => {
  const next = applyDividerDrag({ left: 280, right: 420 }, 'left', 40, 1400);
  assert.deepEqual(next, { left: 320, right: 420 });
});

test('applyDividerDrag 左栏钳制到最小宽度', () => {
  const next = applyDividerDrag({ left: 280, right: 420 }, 'left', -500, 1400);
  assert.equal(next.left, MIN_COLUMN_WIDTH.left);
});

test('applyDividerDrag 左栏上限保证中栏最小宽度', () => {
  const next = applyDividerDrag({ left: 280, right: 420 }, 'left', 10000, 1400);
  assert.equal(next.left, 1400 - 420 - MIN_COLUMN_WIDTH.center);
});

test('applyDividerDrag 右分隔条右移收窄右栏、左移加宽右栏', () => {
  assert.deepEqual(applyDividerDrag({ left: 280, right: 420 }, 'right', 60, 1400), { left: 280, right: 360 });
  assert.deepEqual(applyDividerDrag({ left: 280, right: 420 }, 'right', -40, 1400), { left: 280, right: 460 });
});

test('applyDividerDrag 右栏钳制最小/最大边界', () => {
  const min = applyDividerDrag({ left: 280, right: 420 }, 'right', 10000, 1400);
  assert.equal(min.right, MIN_COLUMN_WIDTH.right);
  const max = applyDividerDrag({ left: 280, right: 420 }, 'right', -10000, 1400);
  assert.equal(max.right, 1400 - 280 - MIN_COLUMN_WIDTH.center);
});

test('applyDividerDrag 容器过窄时退化为最小宽度', () => {
  const next = applyDividerDrag({ left: 280, right: 420 }, 'left', 10000, 800);
  assert.equal(next.left, MIN_COLUMN_WIDTH.left);
});

test('applyDividerDrag 非法入参原样返回', () => {
  const widths = { left: 280, right: 420 };
  assert.equal(applyDividerDrag(widths, 'left', Number.NaN, 1400), widths);
  assert.equal(applyDividerDrag(widths, 'left', 10, Number.NaN), widths);
  assert.equal(applyDividerDrag(widths, 'center' as never, 10, 1400), widths);
});

test('clampColumnWidths 宽度足够时保持不变', () => {
  const widths = { left: 280, right: 420 };
  assert.equal(clampColumnWidths(widths, 1400), widths);
});

test('clampColumnWidths 容器变窄先收右栏再收左栏', () => {
  // budget = 1000 - 320 = 680：右栏先压到最小 280，左栏再让到 400。
  assert.deepEqual(clampColumnWidths({ left: 600, right: 600 }, 1000), { left: 400, right: 280 });
  // 轻微超预算：只收右栏。
  assert.deepEqual(clampColumnWidths({ left: 300, right: 500 }, 1100), { left: 300, right: 480 });
});

test('clampColumnWidths 非法容器宽度原样返回', () => {
  const widths = { left: 280, right: 420 };
  assert.equal(clampColumnWidths(widths, 0), widths);
  assert.equal(clampColumnWidths(widths, Number.NaN), widths);
});

test('clampColumnWidths 隐藏右栏时左栏独占预算、右栏期望值不被改写', () => {
  // 904px 容器（1440×900 视口实测）右栏隐藏：available=898，预算 578 够左栏 280，原样返回。
  const widths = { left: 280, right: 420 };
  assert.equal(clampColumnWidths(widths, 898, { left: true, right: false }), widths);
  // 预算不足时只收左栏，隐藏的右栏保持期望值（恢复可见时再按新预算钳制）。
  assert.deepEqual(clampColumnWidths(widths, 500, { left: true, right: false }), { left: 180, right: 420 });
});

test('clampColumnWidths 隐藏左栏时右栏独占预算、左栏期望值不被改写', () => {
  const widths = { left: 280, right: 420 };
  assert.equal(clampColumnWidths(widths, 898, { left: false, right: true }), widths);
  assert.deepEqual(clampColumnWidths(widths, 500, { left: false, right: true }), { left: 280, right: 280 });
});

test('clampColumnWidths 左右栏都隐藏时不占预算、期望值原样保留', () => {
  // 744px 容器（1280×800 视口实测）双栏隐藏：预算再窄也不触碰期望值。
  const widths = { left: 280, right: 420 };
  assert.equal(clampColumnWidths(widths, 744, { left: false, right: false }), widths);
});

test('clampColumnWidths 以期望值为基准：先萎缩后恢复无单向棘轮', () => {
  const desired = { left: 280, right: 420 };
  // 模拟 744→904→1280 容器变化：渲染宽度每次从 desired 重算，不以萎缩值为新基准。
  const at744 = clampColumnWidths(desired, 744, { left: false, right: false });
  assert.deepEqual(at744, desired);
  const at904 = clampColumnWidths(desired, 904 - 6, { left: true, right: false });
  assert.deepEqual(at904, { left: 280, right: 420 });
  // 两栏全可见时的萎缩：容器变宽后仍从 desired 恢复到 280/420。
  const shrunk = clampColumnWidths(desired, 788, { left: true, right: true });
  assert.deepEqual(shrunk, { left: 188, right: 280 });
  const restored = clampColumnWidths(desired, 1388, { left: true, right: true });
  assert.deepEqual(restored, { left: 280, right: 420 });
});

test('折叠态常量取值固定（栏头条 36px，左右栏默认折叠）', () => {
  assert.equal(COLLAPSED_COLUMN_WIDTH, 36);
  assert.deepEqual(DEFAULT_COLUMN_COLLAPSED, { left: true, right: true });
});

test('serializeColumnLayout / restoreColumnLayout 往返一致（宽度 + 折叠态）', () => {
  const layout = { widths: { left: 312, right: 456 }, collapsed: { left: false, right: true } };
  assert.deepEqual(restoreColumnLayout(JSON.parse(serializeColumnLayout(layout))), layout);
});

test('restoreColumnLayout 空数据/版本不符/非法数值回退默认布局', () => {
  const fallback = { widths: DEFAULT_COLUMN_WIDTHS, collapsed: DEFAULT_COLUMN_COLLAPSED };
  assert.deepEqual(restoreColumnLayout(null), fallback);
  assert.deepEqual(restoreColumnLayout({ v: 99, left: 300, right: 400 }), fallback);
  assert.deepEqual(restoreColumnLayout({ v: 2, left: 'abc', right: 400 }), fallback);
});

test('restoreColumnLayout 兼容 v1 旧记录：保留宽度，折叠态按默认折叠', () => {
  assert.deepEqual(restoreColumnLayout({ v: 1, left: 300, right: 400 }), {
    widths: { left: 300, right: 400 },
    collapsed: DEFAULT_COLUMN_COLLAPSED,
  });
});

test('restoreColumnLayout 折叠态字段非法时回退默认折叠', () => {
  const next = restoreColumnLayout({ v: 2, left: 300, right: 400, collapsedLeft: 'yes', collapsedRight: 0 });
  assert.deepEqual(next.collapsed, DEFAULT_COLUMN_COLLAPSED);
});

test('restoreColumnLayout 过小宽度钳制到最小值', () => {
  const next = restoreColumnLayout({ v: 2, left: 10, right: -5, collapsedLeft: false, collapsedRight: false });
  assert.deepEqual(next, {
    widths: { left: MIN_COLUMN_WIDTH.left, right: MIN_COLUMN_WIDTH.right },
    collapsed: { left: false, right: false },
  });
});

test('saveColumnLayout / loadColumnLayout 经 localStorage 往返（含折叠态）', () => {
  storageData.clear();
  assert.deepEqual(loadColumnLayout(), { widths: DEFAULT_COLUMN_WIDTHS, collapsed: DEFAULT_COLUMN_COLLAPSED });
  saveColumnLayout({ widths: { left: 350, right: 500 }, collapsed: { left: true, right: false } });
  assert.deepEqual(loadColumnLayout(), { widths: { left: 350, right: 500 }, collapsed: { left: true, right: false } });
});

test('loadColumnLayout 存储内容损坏时回退默认布局', () => {
  storageData.clear();
  saveColumnLayout({ widths: { left: 350, right: 500 }, collapsed: { left: false, right: false } });
  const key = 'aih:workbench:column-layout';
  storageData.set(key, '{corrupted');
  assert.deepEqual(loadColumnLayout(), { widths: DEFAULT_COLUMN_WIDTHS, collapsed: DEFAULT_COLUMN_COLLAPSED });
  storageData.set(key, JSON.stringify({ v: 2, left: 260, right: 380, collapsedLeft: false, collapsedRight: true }));
  assert.deepEqual(loadColumnLayout(), { widths: { left: 260, right: 380 }, collapsed: { left: false, right: true } });
});
