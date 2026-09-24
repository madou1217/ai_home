import { useCallback, useEffect, useMemo, useState } from 'react';
import { message, Modal } from 'antd';
import { toolkitAPI } from '@/services/api';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type {
  EnvironmentLifecycleAction,
  EnvironmentResourceItem,
  EnvironmentsResponse,
  WebUiTask
} from '@/types';
import AppActionConfirmContent from './AppActionConfirmContent';
import {
  isLifecycleAction as isEnvironmentLifecycleAction,
  LIFECYCLE_ACTION_LABELS as ACTION_LABELS,
  LIFECYCLE_ACTIONS as ENVIRONMENT_ACTIONS
} from './lifecycle-presentation';
import { toolkitRequestError as requestError } from './request-error';

type PendingAction = { phase: 'planning' | 'submitted'; jobId?: string };

function taskTargetsResource(task: WebUiTask, resourceId: string) {
  return task.source === 'environment'
    && (task.appId === resourceId || task.provider === resourceId);
}

function actionKey(resource: EnvironmentResourceItem, action: EnvironmentLifecycleAction) {
  return `${resource.id}:${action}`;
}

/**
 * 运行环境（Node / Python 工具链）的数据层（桌面面板与移动端共用）：
 * 探测结果、生命周期计划确认与后台任务跟踪。
 */
export function useEnvironmentResources() {
  const [data, setData] = useState<EnvironmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingActions, setPendingActions] = useState<Record<string, PendingAction>>({});
  const { tasks, recentTasks } = useWebUiTaskQueue();

  const load = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading !== false) setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getEnvironments();
      if (!response.ok) throw new Error('环境接口未返回可用结果');
      setData(response);
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取运行环境失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (task?.source !== 'environment') return;
      setPendingActions((current) => {
        const next = { ...current };
        Object.entries(current).forEach(([key, pending]) => {
          if (pending.jobId === task.id || key.startsWith(`${task.appId || task.provider}:`)) delete next[key];
        });
        return next;
      });
      void load({ showLoading: false });
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [load]);

  useEffect(() => {
    if (!recentTasks.length) return;
    setPendingActions((current) => {
      const next = { ...current };
      let changed = false;
      Object.entries(current).forEach(([key, pending]) => {
        if (!pending.jobId) return;
        const completed = recentTasks.find((task) => task.id === pending.jobId && task.source === 'environment'
          && !['queued', 'running'].includes(String(task.status || '').toLowerCase()));
        if (completed) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [recentTasks]);

  const environmentTasks = useMemo(
    () => tasks.filter((task) => task.source === 'environment'),
    [tasks]
  );

  const activeTaskFor = (resource: EnvironmentResourceItem) => environmentTasks.find(
    (task) => taskTargetsResource(task, resource.id)
  );

  const busyActionFor = (resource: EnvironmentResourceItem) => {
    const pending = ENVIRONMENT_ACTIONS
      .find((action) => pendingActions[actionKey(resource, action)]);
    if (pending) return pending;
    const activeAction = activeTaskFor(resource)?.action;
    return isEnvironmentLifecycleAction(activeAction) ? activeAction : undefined;
  };

  const submitAction = async (
    resource: EnvironmentResourceItem,
    action: EnvironmentLifecycleAction,
    key: string
  ) => {
    try {
      const response = await toolkitAPI.executeEnvironmentToolAction(resource.id, action);
      if (!response.ok || !response.job) throw new Error(response.error || '运行环境任务未创建');
      setPendingActions((current) => ({
        ...current,
        [key]: { phase: 'submitted', jobId: response.job?.id }
      }));
      message.info(`${resource.name}${ACTION_LABELS[action]}任务已提交`);
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${resource.name}${ACTION_LABELS[action]}失败`));
    }
  };

  const runAction = async (resource: EnvironmentResourceItem, action: EnvironmentLifecycleAction) => {
    const key = actionKey(resource, action);
    if (busyActionFor(resource)) return;
    setPendingActions((current) => ({ ...current, [key]: { phase: 'planning' } }));
    try {
      const response = await toolkitAPI.planEnvironmentToolAction(resource.id, action);
      if (!response.ok) throw new Error(response.error || '无法生成运行环境计划');
      Modal.confirm({
        title: `${ACTION_LABELS[action]} ${resource.name}`,
        content: (
          <AppActionConfirmContent
            summary={`确认后将创建 ${resource.name}${ACTION_LABELS[action]}任务，进度显示在后台任务队列。`}
            plans={(response.plans || []).map((plan) => ({
              id: plan.id,
              label: plan.label,
              command: plan.command,
              args: plan.args
            }))}
          />
        ),
        okText: '确认执行',
        cancelText: '取消',
        okButtonProps: action === 'uninstall' ? { danger: true } : undefined,
        onOk: () => { void submitAction(resource, action, key); },
        onCancel: () => setPendingActions((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        })
      });
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${resource.name}${ACTION_LABELS[action]}计划生成失败`));
    }
  };

  return { data, loading, error, load, activeTaskFor, busyActionFor, runAction };
}
