import type { ClientPlatform, ToolkitLifecycleAction } from '@/types';

/** 安装生命周期动作的统一中文动词（应用 / 终端 / 运行环境 / 受管工具共用）。 */
export const LIFECYCLE_ACTION_LABELS: Readonly<Record<ToolkitLifecycleAction, string>> = Object.freeze({
  install: '安装',
  update: '更新',
  uninstall: '卸载'
});

export const LIFECYCLE_ACTIONS: readonly ToolkitLifecycleAction[] = ['install', 'update', 'uninstall'];

export function isLifecycleAction(value: unknown): value is ToolkitLifecycleAction {
  return typeof value === 'string'
    && LIFECYCLE_ACTIONS.includes(value as ToolkitLifecycleAction);
}

export const CLIENT_PLATFORM_LABELS: Readonly<Record<ClientPlatform, string>> = Object.freeze({
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
});
