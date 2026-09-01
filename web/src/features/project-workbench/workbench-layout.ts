import {
  applyDividerDrag as applyPolicyDividerDrag,
  clampColumnWidths as clampPolicyColumnWidths,
  restoreColumnWidths as restorePolicyColumnWidths,
  serializeColumnWidths as serializePolicyColumnWidths,
  COLUMN_LAYOUT_BREAKPOINT as POLICY_BREAKPOINT,
  DEFAULT_COLUMN_WIDTHS as POLICY_DEFAULT_WIDTHS,
  DIVIDER_WIDTH as POLICY_DIVIDER_WIDTH,
  MIN_COLUMN_WIDTH as POLICY_MIN_WIDTH,
  resolveLayoutMode as resolvePolicyLayoutMode,
} from './workbench-layout-policy.js';

export type WorkbenchLayoutMode = 'tabs' | 'columns';
export type ColumnDivider = 'left' | 'right';

export interface ColumnWidths {
  readonly left: number;
  readonly right: number;
}

export const COLUMN_LAYOUT_BREAKPOINT = POLICY_BREAKPOINT as number;
export const DIVIDER_WIDTH = POLICY_DIVIDER_WIDTH as number;
export const MIN_COLUMN_WIDTH = POLICY_MIN_WIDTH as Record<'left' | 'center' | 'right', number>;
export const DEFAULT_COLUMN_WIDTHS = POLICY_DEFAULT_WIDTHS as ColumnWidths;

export function resolveLayoutMode(mobile: boolean): WorkbenchLayoutMode {
  return resolvePolicyLayoutMode(mobile) as WorkbenchLayoutMode;
}

export function applyDividerDrag(
  widths: ColumnWidths,
  divider: ColumnDivider,
  deltaPx: number,
  availableWidth: number,
): ColumnWidths {
  return applyPolicyDividerDrag(widths, divider, deltaPx, availableWidth) as ColumnWidths;
}

export function clampColumnWidths(widths: ColumnWidths, availableWidth: number): ColumnWidths {
  return clampPolicyColumnWidths(widths, availableWidth) as ColumnWidths;
}

export function serializeColumnWidths(widths: ColumnWidths): string {
  return serializePolicyColumnWidths(widths) as string;
}

export function restoreColumnWidths(data: unknown): ColumnWidths {
  return restorePolicyColumnWidths(data) as ColumnWidths;
}
