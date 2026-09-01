import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDividerDrag,
  clampColumnWidths,
  COLUMN_LAYOUT_BREAKPOINT,
  DEFAULT_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  resolveLayoutMode,
  restoreColumnWidths,
  serializeColumnWidths,
} from './workbench-layout.ts';
import { loadColumnWidths, saveColumnWidths } from './workbench-layout-persistence.ts';

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

test('serializeColumnWidths / restoreColumnWidths 往返一致', () => {
  const widths = { left: 312, right: 456 };
  assert.deepEqual(restoreColumnWidths(JSON.parse(serializeColumnWidths(widths))), widths);
});

test('restoreColumnWidths 空数据/版本不符/非法数值回退默认宽度', () => {
  assert.deepEqual(restoreColumnWidths(null), DEFAULT_COLUMN_WIDTHS);
  assert.deepEqual(restoreColumnWidths({ v: 99, left: 300, right: 400 }), DEFAULT_COLUMN_WIDTHS);
  assert.deepEqual(restoreColumnWidths({ v: 1, left: 'abc', right: 400 }), DEFAULT_COLUMN_WIDTHS);
});

test('restoreColumnWidths 过小宽度钳制到最小值', () => {
  const next = restoreColumnWidths({ v: 1, left: 10, right: -5 });
  assert.deepEqual(next, { left: MIN_COLUMN_WIDTH.left, right: MIN_COLUMN_WIDTH.right });
});

test('saveColumnWidths / loadColumnWidths 经 localStorage 往返', () => {
  storageData.clear();
  assert.deepEqual(loadColumnWidths(), DEFAULT_COLUMN_WIDTHS);
  saveColumnWidths({ left: 350, right: 500 });
  assert.deepEqual(loadColumnWidths(), { left: 350, right: 500 });
});

test('loadColumnWidths 存储内容损坏时回退默认宽度', () => {
  storageData.clear();
  saveColumnWidths({ left: 350, right: 500 });
  const key = 'aih:workbench:column-layout';
  storageData.set(key, '{corrupted');
  assert.deepEqual(loadColumnWidths(), DEFAULT_COLUMN_WIDTHS);
  storageData.set(key, JSON.stringify({ v: 1, left: 260, right: 380 }));
  assert.deepEqual(loadColumnWidths(), { left: 260, right: 380 });
});
