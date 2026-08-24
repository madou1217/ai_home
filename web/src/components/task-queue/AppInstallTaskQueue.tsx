import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message, Progress } from 'antd';
import {
  CheckCircleOutlined,
  CloseOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RightOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import ManagedAppAccountActions, {
  type ManagedAppLaunchTarget
} from '@/components/toolkit/ManagedAppAccountActions';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { accountsAPI, toolkitAPI } from '@/services/api';
import { useWebUiTaskQueue, type WebUiTaskStreamStatus } from '@/services/webui-task-queue';
import {
  canRetryAppInstallTask,
  getAppInstallFailureReasons,
  getAppInstallStatusPresentation,
  mergeWebUiTaskQueueEntries
} from '@/features/app-install/app-install-presentation';
import type { Account, WebUiTask } from '@/types';
import './AppInstallTaskQueue.css';

function taskName(task: WebUiTask) {
  if (task.taskName) return task.taskName;
  if (task.kind === 'terminal') return `${task.provider || task.appId} 终端操作`;
  return `${task.provider || task.appId} ${task.kind === 'desktop' ? 'Desktop' : 'CLI'} 安装`;
}

function taskAction(task: WebUiTask) {
  if (task.action === 'install') return '安装';
  if (task.action === 'update') return '更新';
  if (task.action === 'uninstall') return '卸载';
  if (task.kind === 'desktop') return '桌面端安装';
  if (task.kind === 'cli') return 'CLI 安装';
  return '后台操作';
}

function phaseLabel(task: WebUiTask) {
  if (task.phase === 'queued') return '等待执行';
  if (task.phase === 'completed') return '已完成';
  if (task.phase === 'failed') return '执行失败';
  return task.phase || '执行中';
}

function streamStatusLabel(status: WebUiTaskStreamStatus) {
  if (status === 'connected') return 'SSE 实时连接';
  if (status === 'reconnecting') return 'SSE 重连中 · 轮询兜底';
  if (status === 'polling') return '轮询已同步';
  if (status === 'offline') return '连接不可用 · 等待恢复';
  return 'SSE 连接中';
}

function updatedLabel(timestamp: number) {
  if (!timestamp) return '等待首次更新';
  return `更新于 ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

export default function AppInstallTaskQueue() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const knownTerminalTaskIdsRef = useRef<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(new Set());
  const [retryingTaskIds, setRetryingTaskIds] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [runningAccountPids, setRunningAccountPids] = useState<Record<string, number[]>>({});
  const [runningCliAccountPids, setRunningCliAccountPids] = useState<Record<string, number[]>>({});
  const [kimiDesktopLoginTarget, setKimiDesktopLoginTarget] = useState<{
    app: ManagedAppLaunchTarget;
    accountRef: string;
  } | null>(null);

  const { tasks, recentTasks, streamStatus } = useWebUiTaskQueue();
  const visibleTasks = useMemo(
    () => mergeWebUiTaskQueueEntries(tasks, recentTasks, dismissedTaskIds),
    [dismissedTaskIds, recentTasks, tasks]
  );
  const hasActiveTask = visibleTasks.some((task) => !getAppInstallStatusPresentation(task.status).terminal);
  const hasFailedTask = visibleTasks.some((task) => String(task.status || '').toLowerCase() === 'failed');
  const hasLaunchableTask = visibleTasks.some((task) => (
    task.source === 'app-install'
      && task.action === 'install'
      && task.status === 'succeeded'
      && (task.kind === 'desktop' || task.kind === 'cli')
  ));

  const refreshLaunchContext = useCallback(async () => {
    const [accountResponse, entryResponse] = await Promise.all([
      accountsAPI.list().catch(() => null),
      accountsAPI.listAppEntries().catch(() => null)
    ]);
    if (accountResponse) setAccounts(accountResponse.accounts || []);
    if (entryResponse) {
      setRunningAccountPids(entryResponse.runningAccountPids || {});
      setRunningCliAccountPids(entryResponse.runningCliAccountPids || {});
    }
  }, []);

  useEffect(() => {
    if (hasLaunchableTask) void refreshLaunchContext();
  }, [hasLaunchableTask, refreshLaunchContext]);

  useEffect(() => {
    if (!expanded) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.ant-dropdown')) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded]);

  useEffect(() => {
    const nextTerminalIds = new Set(
      visibleTasks
        .filter((task) => getAppInstallStatusPresentation(task.status).terminal)
        .map((task) => task.id)
    );
    const hasNewTerminalTask = [...nextTerminalIds]
      .some((taskId) => !knownTerminalTaskIdsRef.current.has(taskId));
    knownTerminalTaskIdsRef.current = nextTerminalIds;
    if (hasNewTerminalTask) setExpanded(true);
    if (!visibleTasks.length) setExpanded(false);
  }, [visibleTasks]);

  const dismissTask = (taskId: string) => {
    setDismissedTaskIds((current) => new Set(current).add(taskId));
  };

  const retryTask = async (task: WebUiTask) => {
    if (!canRetryAppInstallTask(task) || retryingTaskIds.has(task.id)) return;
    const action = task.action as 'install' | 'update' | 'uninstall';
    const kind = task.kind === 'desktop' || task.kind === 'cli' || task.kind === 'ide'
      ? task.kind
      : undefined;
    setRetryingTaskIds((current) => new Set(current).add(task.id));
    try {
      const response = await toolkitAPI.executeAppAction(task.appId, action, kind);
      if (!response.ok || !response.job) throw new Error(response.error || '重试任务未创建');
      dismissTask(task.id);
      message.info(`${taskName(task)}已重新进入任务队列`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : '重新提交失败';
      message.error(reason);
    } finally {
      setRetryingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const openManagedApp = async (app: ManagedAppLaunchTarget, accountRef?: string, unscoped = false) => {
    const kind = app.type === 'desktop' ? 'desktop' : 'cli';
    try {
      const response = await toolkitAPI.openManagedApp(app.id, {
        kind,
        ...(accountRef ? { accountRef } : {}),
        ...(unscoped ? { unscoped: true } : {})
      });
      if (!response.ok) throw new Error(response.message || response.error || '应用启动失败');
      message.success(response.status === 'already_running' ? `${app.name} 已在运行` : `${app.name} 已启动`);
      if (response.egressWarning) {
        message.warning(`ZCode 出口未生效：${response.egressWarning}`);
      }
      await refreshLaunchContext();
    } catch (error: unknown) {
      const responseData = typeof error === 'object' && error
        ? (error as { response?: { data?: { error?: string; message?: string } } }).response?.data
        : undefined;
      const code = String(responseData?.error || '');
      if (kind === 'desktop' && app.provider === 'kimi' && accountRef
        && (code === 'kimi_desktop_session_required' || code === 'kimi_desktop_session_seed_failed')) {
        setKimiDesktopLoginTarget({ app, accountRef });
        if (code === 'kimi_desktop_session_seed_failed') {
          message.warning(responseData?.message || 'Kimi Desktop 登录态需要重新托管');
        }
        return;
      }
      message.error(responseData?.message || (error instanceof Error ? error.message : `${app.name} 启动失败`));
    }
  };

  const closeManagedApp = async (app: ManagedAppLaunchTarget, accountRef: string) => {
    const kind = app.type === 'desktop' ? 'desktop' : 'cli';
    try {
      const response = await toolkitAPI.openManagedApp(app.id, {
        kind,
        accountRef,
        action: 'close'
      });
      if (!response.ok) throw new Error(response.message || response.error || '结束应用失败');
      message.success(kind === 'desktop' ? 'Desktop 实例已结束' : '该账号的 CLI 会话已结束');
      await refreshLaunchContext();
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : `${app.name} 结束失败`);
    }
  };

  if (!visibleTasks.length) return null;

  return (
    <div
      ref={rootRef}
      className={`webui-task-queue${expanded ? ' is-expanded' : ''}`}
      data-task-count={visibleTasks.length}
    >
      <button
        type="button"
        className="webui-task-queue-trigger"
        aria-expanded={expanded}
        aria-label={expanded ? '收起后台任务队列' : `打开后台任务队列，共 ${visibleTasks.length} 个任务`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="webui-task-queue-trigger-icon" aria-hidden="true">
          {expanded
            ? <CloseOutlined />
            : hasActiveTask
              ? <LoadingOutlined spin />
              : hasFailedTask
                ? <ExclamationCircleOutlined />
                : <CheckCircleOutlined />}
        </span>
        <span className="webui-task-queue-count">{visibleTasks.length}</span>
        <span className="webui-task-queue-trigger-label">{hasActiveTask ? '后台任务' : '任务结果'}</span>
      </button>

      <section
        className="webui-task-queue-panel"
        aria-label="后台任务队列"
        aria-hidden={!expanded}
        aria-live={expanded ? 'polite' : 'off'}
      >
        <header className="webui-task-queue-header">
          <div>
            <span className="webui-task-queue-kicker">BACKGROUND TASKS</span>
            <strong>后台任务队列</strong>
          </div>
          <span className={`webui-task-queue-stream-status is-${streamStatus}`}>
            <i aria-hidden="true" />
            {streamStatusLabel(streamStatus)}
          </span>
        </header>
        <div className="webui-task-queue-list">
          {visibleTasks.map((task) => {
            const status = getAppInstallStatusPresentation(task.status);
            const percent = status.tone === 'success'
              ? 100
              : Math.round(Number(task.progress?.percent || 0));
            const failureReasons = status.tone === 'error' ? getAppInstallFailureReasons(task) : [];
            const launchable = task.source === 'app-install'
              && task.action === 'install'
              && task.status === 'succeeded'
              && (task.kind === 'desktop' || task.kind === 'cli');
            const launchTarget: ManagedAppLaunchTarget | null = launchable ? {
              id: task.appId,
              name: taskName(task),
              provider: task.provider as ManagedAppLaunchTarget['provider'],
              type: task.kind as 'desktop' | 'cli'
            } : null;
            return (
              <article className={`webui-task-queue-item is-${status.tone}`} key={task.id}>
                <div className="webui-task-queue-item-heading">
                  <strong title={taskName(task)}>{taskName(task)}</strong>
                  <span>{status.label}</span>
                </div>
                <div className="webui-task-queue-item-meta">
                  <span>{taskAction(task)}</span>
                  <span>{phaseLabel(task)}</span>
                  <span>{task.source === 'terminal' ? '终端' : '应用'}</span>
                </div>
                <Progress
                  percent={percent}
                  size="small"
                  showInfo
                  status={status.tone === 'success' ? 'success' : status.tone === 'error' ? 'exception' : 'active'}
                />
                <div className="webui-task-queue-item-detail">
                  <span>{task.progress?.label || '等待状态更新'}</span>
                  <span>{updatedLabel(Number(task.updatedAt || 0))}</span>
                </div>
                {failureReasons.length ? (
                  <details className="webui-task-queue-failure">
                    <summary>查看失败原因</summary>
                    <ul>
                      {failureReasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  </details>
                ) : null}
                {status.terminal ? (
                  <div className="webui-task-queue-item-actions">
                    {launchTarget ? (
                      <ManagedAppAccountActions
                        app={launchTarget}
                        accounts={accounts}
                        runningAccountPids={runningAccountPids}
                        runningCliAccountPids={runningCliAccountPids}
                        buttonLabel="选择账号并打开"
                        onOpen={openManagedApp}
                        onClose={closeManagedApp}
                      />
                    ) : null}
                    {canRetryAppInstallTask(task) ? (
                      <Button
                        type="text"
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={retryingTaskIds.has(task.id)}
                        onClick={() => { void retryTask(task); }}
                      >
                        重新执行
                      </Button>
                    ) : null}
                    <Button type="text" size="small" onClick={() => dismissTask(task.id)}>关闭结果</Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        <button
          type="button"
          className="webui-task-queue-collapse-hint"
          onClick={() => setExpanded(false)}
        >
          点击其他区域自动收起 <RightOutlined aria-hidden="true" />
        </button>
      </section>
      <KimiDesktopLoginModal
        open={Boolean(kimiDesktopLoginTarget)}
        accountRef={kimiDesktopLoginTarget?.accountRef || ''}
        accountLabel={accounts.find((account) => account.accountRef === kimiDesktopLoginTarget?.accountRef)?.displayName || ''}
        onClose={() => setKimiDesktopLoginTarget(null)}
        onSuccess={() => {
          const target = kimiDesktopLoginTarget;
          setKimiDesktopLoginTarget(null);
          if (target) void openManagedApp(target.app, target.accountRef);
        }}
      />
    </div>
  );
}
