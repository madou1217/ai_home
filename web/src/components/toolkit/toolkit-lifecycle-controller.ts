import type { ToolkitLifecycleAction, WebUiTask } from '@/types';

export type ToolkitLifecyclePending = {
  phase: 'planning' | 'submitted';
  jobId?: string;
};

export type ToolkitLifecyclePendingMap = Record<string, ToolkitLifecyclePending>;

export const TOOLKIT_LIFECYCLE_ACTIONS: readonly ToolkitLifecycleAction[] = [
  'install',
  'update',
  'uninstall'
];

export const TOOLKIT_LIFECYCLE_ACTION_LABELS: Record<ToolkitLifecycleAction, string> = {
  install: '安装',
  update: '更新',
  uninstall: '卸载'
};

export function isToolkitLifecycleAction(value: unknown): value is ToolkitLifecycleAction {
  return typeof value === 'string'
    && TOOLKIT_LIFECYCLE_ACTIONS.includes(value as ToolkitLifecycleAction);
}

export function lifecycleActionKey(resourceId: string, action: string) {
  return `${String(resourceId || '').trim()}:${String(action || '').trim().toLowerCase()}`;
}

export function isLifecycleTaskFinished(task: WebUiTask | null | undefined) {
  return Boolean(task && !['queued', 'running'].includes(String(task.status || '').trim().toLowerCase()));
}

export function taskTargetsLifecycleResource(
  task: WebUiTask,
  source: string,
  resourceIds: string[]
) {
  if (task.source !== source) return false;
  const targets = new Set(resourceIds.map((id) => String(id || '').trim()).filter(Boolean));
  return targets.has(String(task.appId || '').trim())
    || targets.has(String(task.provider || '').trim());
}

export function clearCompletedLifecyclePending(
  pending: ToolkitLifecyclePendingMap,
  task: WebUiTask,
  source: string
) {
  if (task.source !== source || !isLifecycleTaskFinished(task)) return pending;
  const targetIds = [task.appId, task.provider]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const next = { ...pending };
  let changed = false;
  Object.entries(pending).forEach(([key, item]) => {
    const sameJob = Boolean(item.jobId && item.jobId === task.id);
    const sameTarget = targetIds.some((targetId) => key.startsWith(`${targetId}:`));
    if (!sameJob && !sameTarget) return;
    delete next[key];
    changed = true;
  });
  return changed ? next : pending;
}
