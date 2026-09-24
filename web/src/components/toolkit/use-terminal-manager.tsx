import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, message } from 'antd';
import { toolkitAPI } from '@/services/api';
import { isActiveWebUiTask, useWebUiTaskQueue } from '@/services/webui-task-queue';
import type { ClientPlatform, ClientTerminalItem, ToolkitLifecycleAction as TerminalAction, WebUiTask } from '@/types';
import AppActionConfirmContent from './AppActionConfirmContent';
import { LIFECYCLE_ACTION_LABELS as ACTION_LABELS } from './lifecycle-presentation';
import { toolkitRequestError as requestError } from './request-error';

type PendingAction = {
  phase: 'planning' | 'submitted';
  jobId?: string;
};

function taskTargetsTerminal(task: WebUiTask, terminalId: string) {
  return task.source === 'terminal'
    && (task.appId === terminalId || task.provider === terminalId);
}

function isTerminalJobFinished(task: WebUiTask | null | undefined) {
  return Boolean(task && !isActiveWebUiTask(task));
}

/**
 * 终端管理的数据层（桌面面板与移动端共用）：探测清单、唤起终端、
 * 安装 / 更新 / 卸载走「生成计划 → 确认 → 后台任务队列」，并跟踪提交中的任务。
 */
export function useTerminalManager() {
  const [terminals, setTerminals] = useState<ClientTerminalItem[]>([]);
  const [platform, setPlatform] = useState<ClientPlatform | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [pendingActions, setPendingActions] = useState<Record<string, PendingAction>>({});
  const pendingKeysRef = useRef(new Set<string>());
  const { tasks, recentTasks } = useWebUiTaskQueue();

  const activeTerminalTasks = useMemo(
    () => tasks.filter((task) => task.source === 'terminal'),
    [tasks]
  );

  const updatePendingAction = useCallback((key: string, pending: PendingAction | null) => {
    if (pending) pendingKeysRef.current.add(key);
    else pendingKeysRef.current.delete(key);
    setPendingActions((current) => {
      const next = { ...current };
      if (pending) next[key] = pending;
      else delete next[key];
      return next;
    });
  }, []);

  const clearPendingJob = useCallback((task: WebUiTask) => {
    setPendingActions((current) => {
      const next = { ...current };
      let changed = false;
      Object.entries(current).forEach(([key, pending]) => {
        const sameJob = pending.jobId && pending.jobId === task.id;
        const sameTarget = task.action && key === `${task.appId || task.provider}:${task.action}`;
        if (sameJob || sameTarget) {
          pendingKeysRef.current.delete(key);
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.listTerminals();
      if (!response.ok) throw new Error('终端接口未返回可用结果');
      setPlatform(response.platform || '');
      setTerminals((response.terminals || []).filter((terminal) => terminal.platform === response.platform));
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取终端清单失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const openTerminal = async (terminal: ClientTerminalItem) => {
    setOpeningId(terminal.id);
    try {
      const result = await toolkitAPI.openTerminal(terminal.id);
      if (!result.ok) throw new Error(result.error || '终端唤起失败');
      message.success(`${terminal.name} 已唤起`);
    } catch (error: unknown) {
      message.error(requestError(error, `${terminal.name} 唤起失败`));
    } finally {
      setOpeningId('');
    }
  };

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (task?.source !== 'terminal') return;
      clearPendingJob(task);
      void load();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [clearPendingJob, load]);

  useEffect(() => {
    setPendingActions((current) => {
      const next = { ...current };
      let changed = false;
      Object.entries(current).forEach(([key, pending]) => {
        if (!pending.jobId) return;
        const completed = recentTasks.find((task) => task.id === pending.jobId && isTerminalJobFinished(task));
        if (completed) {
          pendingKeysRef.current.delete(key);
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [recentTasks]);

  useEffect(() => {
    const submitted = Object.entries(pendingActions)
      .filter(([, pending]) => pending.phase === 'submitted' && pending.jobId);
    if (!submitted.length) return undefined;
    let disposed = false;
    const pollJobs = async () => {
      await Promise.all(submitted.map(async ([key, pending]) => {
        if (!pending.jobId) return;
        try {
          const task = await toolkitAPI.getTerminalJob(pending.jobId);
          if (!disposed && isTerminalJobFinished(task)) updatePendingAction(key, null);
        } catch (_error) {
          // SSE and the shared queue remain the primary state channel.
        }
      }));
    };
    const timer = window.setInterval(() => { void pollJobs(); }, 3000);
    void pollJobs();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pendingActions, updatePendingAction]);

  const submitTerminalAction = async (terminal: ClientTerminalItem, action: TerminalAction, key: string) => {
    try {
      const result = await toolkitAPI.executeTerminalAction(terminal.id, action);
      if (!result.ok) throw new Error(result.error || '终端操作失败');
      updatePendingAction(key, { phase: 'submitted', jobId: result.job?.id });
      message.info(`${terminal.name}${ACTION_LABELS[action]}任务已提交`);
    } catch (error: unknown) {
      updatePendingAction(key, null);
      message.error(requestError(error, '终端操作失败'));
    }
  };

  const runAction = async (terminal: ClientTerminalItem, action: TerminalAction) => {
    const key = `${terminal.id}:${action}`;
    const targetBusy = activeTerminalTasks.some((task) => taskTargetsTerminal(task, terminal.id));
    if (targetBusy || pendingKeysRef.current.has(key)) return;
    updatePendingAction(key, { phase: 'planning' });
    try {
      const plan = await toolkitAPI.planTerminalAction(terminal.id, action);
      if (!plan.ok) throw new Error(plan.error || '无法生成终端操作计划');
      Modal.confirm({
        title: `${ACTION_LABELS[action]} ${terminal.name}`,
        content: (
          <AppActionConfirmContent
            summary={`确认后将创建 ${terminal.name}${ACTION_LABELS[action]}任务，进度显示在后台任务队列。`}
            plans={[{
              id: `${terminal.id}:${action}`,
              label: plan.label || `${ACTION_LABELS[action]} ${terminal.name}`,
              command: plan.file || plan.command || '',
              args: plan.args || []
            }]}
          />
        ),
        okText: '确认执行',
        cancelText: '取消',
        okButtonProps: action === 'uninstall' ? { danger: true } : undefined,
        // 立即关闭确认层；命令已在服务端异步排队，进度只由全局任务队列呈现。
        onOk: () => { void submitTerminalAction(terminal, action, key); },
        onCancel: () => updatePendingAction(key, null)
      });
    } catch (error: unknown) {
      updatePendingAction(key, null);
      message.error(requestError(error, '生成终端操作计划失败'));
    }
  };

  const activeTaskFor = (terminal: ClientTerminalItem) => activeTerminalTasks.find(
    (task) => taskTargetsTerminal(task, terminal.id)
  );

  const actionBusyState = (terminal: ClientTerminalItem, action: TerminalAction) => {
    const key = `${terminal.id}:${action}`;
    const pending = pendingActions[key];
    const activeTask = activeTaskFor(terminal);
    const active = activeTask?.action === action ? activeTask : undefined;
    return {
      pending,
      active,
      busy: Boolean(pending || active)
    };
  };

  const terminalLifecycleBusy = (terminal: ClientTerminalItem) => activeTerminalTasks.some(
    (task) => taskTargetsTerminal(task, terminal.id)
  ) || Object.keys(pendingActions).some((key) => key.startsWith(`${terminal.id}:`));

  return {
    terminals,
    platform,
    loading,
    error,
    openingId,
    load,
    openTerminal,
    runAction,
    activeTaskFor,
    actionBusyState,
    terminalLifecycleBusy
  };
}
