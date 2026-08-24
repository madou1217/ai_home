import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message, Modal } from 'antd';
import type { AppActionPlanPresentation } from '@/features/app-install/app-install-presentation';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type { ToolkitLifecycleAction, WebUiTask } from '@/types';
import AppActionConfirmContent from './AppActionConfirmContent';
import {
  clearCompletedLifecyclePending,
  isToolkitLifecycleAction,
  lifecycleActionKey,
  taskTargetsLifecycleResource,
  TOOLKIT_LIFECYCLE_ACTION_LABELS,
  TOOLKIT_LIFECYCLE_ACTIONS,
  type ToolkitLifecyclePending,
  type ToolkitLifecyclePendingMap
} from './toolkit-lifecycle-controller';

interface LifecycleResource {
  id: string;
  name: string;
}

interface LifecyclePlanResponse {
  ok: boolean;
  error?: string;
  message?: string;
}

interface LifecycleExecutionResponse {
  ok: boolean;
  job?: Pick<WebUiTask, 'id'>;
  error?: string;
  message?: string;
}

interface LifecycleConfirmation {
  title?: string;
  summary?: string;
  metadata?: Array<{ label: string; value: string }>;
}

interface ToolkitLifecycleControllerOptions<
  Resource extends LifecycleResource,
  PlanResponse extends LifecyclePlanResponse
> {
  source: string;
  scopeLabel: string;
  refresh: () => void | Promise<void>;
  plan: (resource: Resource, action: ToolkitLifecycleAction) => Promise<PlanResponse>;
  execute: (resource: Resource, action: ToolkitLifecycleAction) => Promise<LifecycleExecutionResponse>;
  plans: (
    response: PlanResponse,
    resource: Resource,
    action: ToolkitLifecycleAction
  ) => AppActionPlanPresentation[];
  resourceIds?: (resource: Resource) => string[];
}

function requestError(error: unknown, fallback: string) {
  if (typeof error !== 'object' || !error) return fallback;
  const candidate = error as {
    response?: { data?: { message?: string; error?: string } };
    message?: string;
  };
  return candidate.response?.data?.message
    || candidate.response?.data?.error
    || candidate.message
    || fallback;
}

export default function useToolkitLifecycleController<
  Resource extends LifecycleResource,
  PlanResponse extends LifecyclePlanResponse
>({
  source,
  scopeLabel,
  refresh,
  plan,
  execute,
  plans,
  resourceIds = (resource) => [resource.id]
}: ToolkitLifecycleControllerOptions<Resource, PlanResponse>) {
  const [pendingActions, setPendingActions] = useState<ToolkitLifecyclePendingMap>({});
  const pendingRef = useRef<ToolkitLifecyclePendingMap>({});
  const { tasks, recentTasks } = useWebUiTaskQueue();
  const sourceTasks = useMemo(
    () => tasks.filter((task) => task.source === source),
    [source, tasks]
  );

  const replacePending = useCallback((next: ToolkitLifecyclePendingMap) => {
    pendingRef.current = next;
    setPendingActions(next);
  }, []);

  const updatePending = useCallback((key: string, pending: ToolkitLifecyclePending | null) => {
    const next = { ...pendingRef.current };
    if (pending) next[key] = pending;
    else delete next[key];
    replacePending(next);
  }, [replacePending]);

  const activeTaskFor = useCallback((resource: Resource) => {
    const ids = resourceIds(resource);
    return sourceTasks.find((task) => taskTargetsLifecycleResource(task, source, ids));
  }, [resourceIds, source, sourceTasks]);

  const busyActionFor = useCallback((resource: Resource) => {
    const pendingAction = TOOLKIT_LIFECYCLE_ACTIONS.find(
      (action) => pendingRef.current[lifecycleActionKey(resource.id, action)]
    );
    if (pendingAction) return pendingAction;
    const activeAction = activeTaskFor(resource)?.action;
    return isToolkitLifecycleAction(activeAction) ? activeAction : undefined;
  }, [activeTaskFor]);

  const isResourceBusy = useCallback(
    (resource: Resource) => Boolean(busyActionFor(resource)),
    [busyActionFor]
  );

  const clearTask = useCallback((task: WebUiTask) => {
    const next = clearCompletedLifecyclePending(pendingRef.current, task, source);
    if (next !== pendingRef.current) replacePending(next);
  }, [replacePending, source]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (!task || task.source !== source) return;
      clearTask(task);
      void refresh();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [clearTask, refresh, source]);

  useEffect(() => {
    let next = pendingRef.current;
    recentTasks.forEach((task) => {
      next = clearCompletedLifecyclePending(next, task, source);
    });
    if (next === pendingRef.current) return;
    replacePending(next);
    void refresh();
  }, [recentTasks, refresh, replacePending, source]);

  const submitAction = useCallback(async (
    resource: Resource,
    action: ToolkitLifecycleAction,
    key: string
  ) => {
    try {
      const response = await execute(resource, action);
      if (!response.ok || !response.job?.id) {
        throw new Error(response.message || response.error || `${scopeLabel}任务未创建`);
      }
      updatePending(key, { phase: 'submitted', jobId: response.job.id });
      message.info(`${resource.name}${TOOLKIT_LIFECYCLE_ACTION_LABELS[action]}任务已提交`);
    } catch (error: unknown) {
      updatePending(key, null);
      message.error(requestError(
        error,
        `${resource.name}${TOOLKIT_LIFECYCLE_ACTION_LABELS[action]}失败`
      ));
    }
  }, [execute, scopeLabel, updatePending]);

  const runAction = useCallback(async (
    resource: Resource,
    action: ToolkitLifecycleAction,
    confirmation: LifecycleConfirmation = {}
  ) => {
    const key = lifecycleActionKey(resource.id, action);
    if (isResourceBusy(resource)) return;
    updatePending(key, { phase: 'planning' });
    try {
      const response = await plan(resource, action);
      if (!response.ok) {
        throw new Error(response.message || response.error || `无法生成${scopeLabel}操作计划`);
      }
      Modal.confirm({
        title: confirmation.title
          || `${TOOLKIT_LIFECYCLE_ACTION_LABELS[action]} ${resource.name}`,
        content: (
          <AppActionConfirmContent
            summary={confirmation.summary
              || `确认后将创建 ${resource.name}${TOOLKIT_LIFECYCLE_ACTION_LABELS[action]}任务，进度显示在后台任务队列。`}
            plans={plans(response, resource, action)}
            metadata={confirmation.metadata}
          />
        ),
        okText: '确认执行',
        cancelText: '取消',
        okButtonProps: action === 'uninstall' ? { danger: true } : undefined,
        onOk: () => { void submitAction(resource, action, key); },
        onCancel: () => updatePending(key, null)
      });
    } catch (error: unknown) {
      updatePending(key, null);
      message.error(requestError(
        error,
        `${resource.name}${TOOLKIT_LIFECYCLE_ACTION_LABELS[action]}计划生成失败`
      ));
    }
  }, [isResourceBusy, plan, plans, scopeLabel, submitAction, updatePending]);

  return {
    activeTaskFor,
    busyActionFor,
    isResourceBusy,
    pendingActions,
    runAction
  };
}
