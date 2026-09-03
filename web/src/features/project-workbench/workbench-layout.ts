import {
  applyDividerDrag as applyPolicyDividerDrag,
  clampColumnWidths as clampPolicyColumnWidths,
  restoreColumnLayout as restorePolicyColumnLayout,
  serializeColumnLayout as serializePolicyColumnLayout,
  COLLAPSED_COLUMN_WIDTH as POLICY_COLLAPSED_WIDTH,
  COLUMN_COMFORTABLE_WIDTH as POLICY_COMFORTABLE_WIDTH,
  COLUMN_SIDEBAR_WIDTH as POLICY_SIDEBAR_WIDTH,
  COLUMN_LAYOUT_BREAKPOINT as POLICY_BREAKPOINT,
  DEFAULT_COLUMN_COLLAPSED as POLICY_DEFAULT_COLLAPSED,
  DEFAULT_COLUMN_WIDTHS as POLICY_DEFAULT_WIDTHS,
  DIVIDER_WIDTH as POLICY_DIVIDER_WIDTH,
  MIN_COLUMN_WIDTH as POLICY_MIN_WIDTH,
  resolveColumnVisibility as resolvePolicyColumnVisibility,
  resolveLayoutMode as resolvePolicyLayoutMode,
} from './workbench-layout-policy.js';

export type WorkbenchLayoutMode = 'tabs' | 'columns';
export type ColumnDivider = 'left' | 'right';

export interface ColumnWidths {
  readonly left: number;
  readonly right: number;
}

export interface ColumnCollapsed {
  readonly left: boolean;
  readonly right: boolean;
}

// 栏布局持久化单元：期望宽度 + 折叠态（同一 localStorage 记录，同版本迁移）。
export interface ColumnLayout {
  readonly widths: ColumnWidths;
  readonly collapsed: ColumnCollapsed;
}

export interface ColumnVisibility {
  readonly left: boolean;
  readonly right: boolean;
}

export const COLUMN_LAYOUT_BREAKPOINT = POLICY_BREAKPOINT as number;
export const DIVIDER_WIDTH = POLICY_DIVIDER_WIDTH as number;
export const COLLAPSED_COLUMN_WIDTH = POLICY_COLLAPSED_WIDTH as number;
export const MIN_COLUMN_WIDTH = POLICY_MIN_WIDTH as Record<'left' | 'center' | 'right', number>;
export const DEFAULT_COLUMN_WIDTHS = POLICY_DEFAULT_WIDTHS as ColumnWidths;
export const DEFAULT_COLUMN_COLLAPSED = POLICY_DEFAULT_COLLAPSED as ColumnCollapsed;
export const COLUMN_COMFORTABLE_WIDTH = POLICY_COMFORTABLE_WIDTH as number;
export const COLUMN_SIDEBAR_WIDTH = POLICY_SIDEBAR_WIDTH as number;

export function resolveLayoutMode(mobile: boolean): WorkbenchLayoutMode {
  return resolvePolicyLayoutMode(mobile) as WorkbenchLayoutMode;
}

// 容器宽度 -> 栏可见性（三档：全显 / 隐藏右栏 / 只剩中栏）。
export function resolveColumnVisibility(containerWidth: number): ColumnVisibility {
  return resolvePolicyColumnVisibility(containerWidth) as ColumnVisibility;
}

export function applyDividerDrag(
  widths: ColumnWidths,
  divider: ColumnDivider,
  deltaPx: number,
  availableWidth: number,
): ColumnWidths {
  return applyPolicyDividerDrag(widths, divider, deltaPx, availableWidth) as ColumnWidths;
}

export function clampColumnWidths(
  widths: ColumnWidths,
  availableWidth: number,
  visibility?: ColumnVisibility,
): ColumnWidths {
  return clampPolicyColumnWidths(widths, availableWidth, visibility) as ColumnWidths;
}

export function serializeColumnLayout(layout: ColumnLayout): string {
  return serializePolicyColumnLayout(layout) as string;
}

export function restoreColumnLayout(data: unknown): ColumnLayout {
  return restorePolicyColumnLayout(data) as ColumnLayout;
}
