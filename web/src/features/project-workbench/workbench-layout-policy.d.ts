// 类型由 workbench-layout.ts 声明并断言；这里只描述 JS 的导出形状。
interface PolicyColumnWidths { readonly left: number; readonly right: number }
interface PolicyColumnFlags { readonly left: boolean; readonly right: boolean }

export declare const COLUMN_LAYOUT_BREAKPOINT: number;
export declare const MIN_COLUMN_WIDTH: Readonly<{ left: number; center: number; right: number }>;
export declare const DEFAULT_COLUMN_WIDTHS: Readonly<PolicyColumnWidths>;
export declare const DIVIDER_WIDTH: number;
export declare const COLLAPSED_COLUMN_WIDTH: number;
export declare const DEFAULT_COLUMN_COLLAPSED: Readonly<PolicyColumnFlags>;
export declare const COLUMN_COMFORTABLE_WIDTH: number;
export declare const COLUMN_SIDEBAR_WIDTH: number;

export declare function resolveLayoutMode(mobile: boolean): 'tabs' | 'columns';
export declare function resolveColumnVisibility(containerWidth: number): PolicyColumnFlags;
export declare function applyDividerDrag(
  widths: PolicyColumnWidths,
  divider: 'left' | 'right',
  deltaPx: number,
  availableWidth: number
): PolicyColumnWidths;
export declare function clampColumnWidths(
  widths: PolicyColumnWidths,
  availableWidth: number,
  visibility?: PolicyColumnFlags
): PolicyColumnWidths;
export declare function serializeColumnLayout(layout: {
  readonly widths: PolicyColumnWidths;
  readonly collapsed: PolicyColumnFlags;
}): string;
export declare function restoreColumnLayout(data: unknown): {
  widths: PolicyColumnWidths;
  collapsed: PolicyColumnFlags;
};
