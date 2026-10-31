// 类型由 workbench-persistence.ts 声明并断言；这里只描述 JS 的导出形状。
export declare function workbenchProjectStorageKey(projectPath: string): string;
export declare function serializeWorkbenchState(state: {
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly label: string }>;
  readonly activeTabId: string;
}): string;
export declare function restoreWorkbenchState(data: unknown): unknown;
