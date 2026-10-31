// 类型由 TS 包装层（workbench-types.ts / workbench-reducer.ts）声明并断言；这里只描述 JS 的导出形状。
export declare const PANEL_LABELS: Readonly<Record<string, string>>;
export declare const PANEL_LIMITS: Readonly<Record<string, number>>;
export declare function nextWorkbenchTabId(kind: string): string;
export declare function createInitialWorkbenchState(): unknown;
export declare function reduceWorkbenchState<S>(state: S, action: { readonly type: string }): S;
