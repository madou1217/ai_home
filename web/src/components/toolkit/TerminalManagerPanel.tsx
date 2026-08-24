import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Modal, Space, Spin, Tag, Tooltip, message } from 'antd';
import { CodeOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import { isActiveWebUiTask, useWebUiTaskQueue } from '@/services/webui-task-queue';
import type { ClientPlatform, ClientTerminalItem, WebUiTask } from '@/types';
import InstallLifecycleAction, { type InstallLifecycleActionName as TerminalAction } from './InstallLifecycleAction';
import AppActionConfirmContent from './AppActionConfirmContent';
import ManagedClientIcon from './ManagedClientIcon';
import ManagedResourceCard from './ManagedResourceCard';
import {
  getTerminalExecutablePresentation,
  hasManagedTerminalLifecycle
} from './terminal-presentation';
import ToolkitStatusTrack from './ToolkitStatusTrack';

const PLATFORM_LABELS: Record<ClientPlatform, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
};

const ACTION_LABELS: Record<TerminalAction, string> = {
  install: '安装',
  update: '更新',
  uninstall: '卸载'
};

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

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
  }
  return fallback;
}

export default function TerminalManagerPanel() {
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

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-terminals-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">TERMINAL RUNTIME</div>
          <h2 id="toolkit-terminals-title">终端管理</h2>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <strong>终端清单读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {loading && !terminals.length ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测终端" /></div>
      ) : terminals.length ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="终端管理状态轨道"
            items={[
              {
                label: '当前系统',
                value: platform ? PLATFORM_LABELS[platform] || platform : '当前系统',
                detail: '只展示本机支持的终端',
                tone: 'info'
              },
              {
                label: '终端资源',
                value: `${terminals.filter((terminal) => terminal.installed || terminal.default).length} / ${terminals.length} 可用`,
                detail: '安装状态来自当前主机探测',
                tone: terminals.some((terminal) => terminal.installed || terminal.default) ? 'success' : 'neutral'
              },
              {
                label: '生命周期',
                value: '后台任务',
                detail: '安装、更新、卸载统一进入任务队列',
                tone: 'neutral'
              }
            ]}
          />
          <div className="toolkit-grid">
            {terminals.map((terminal) => {
              const executable = getTerminalExecutablePresentation(terminal);
              return (
                <ManagedResourceCard
                  key={terminal.id}
                  resourceId={terminal.id}
                  name={terminal.name}
                  installed={terminal.installed}
                  icon={<ManagedClientIcon clientType="terminal" clientName={terminal.name} />}
                  badges={<Tag color={terminal.default ? 'blue' : 'default'}>{terminal.default ? '系统默认' : '可选终端'}</Tag>}
                  details={[
                    {
                      label: '程序路径',
                      value: executable.value,
                      tooltip: executable.tooltip,
                      muted: executable.muted
                    },
                    ...(terminal.sourceUrl ? [{
                      label: '官方文档',
                      value: <a href={terminal.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>
                    }] : [])
                  ]}
                  actions={(
                    <Space size={6} wrap>
                      {(() => {
                        const activeTask = activeTaskFor(terminal);
                        const lifecycleBusy = terminalLifecycleBusy(terminal);
                        const updateState = actionBusyState(terminal, 'update');
                        const uninstallState = actionBusyState(terminal, 'uninstall');
                        const managedLifecycle = hasManagedTerminalLifecycle(terminal);
                        return (
                          <>
                            {activeTask ? (
                              <Tag color="processing">
                                {ACTION_LABELS[(activeTask.action as TerminalAction) || 'update'] || '操作'}中
                                {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                              </Tag>
                            ) : null}
                            {terminal.canLaunch && (terminal.installed || terminal.default) && (
                              <Tooltip title={`唤起 ${terminal.name}`}>
                                <Button
                                  size="small"
                                  shape="circle"
                                  icon={<CodeOutlined />}
                                  aria-label={`唤起 ${terminal.name}`}
                                  loading={openingId === terminal.id}
                                  disabled={lifecycleBusy}
                                  onClick={() => void openTerminal(terminal)}
                                />
                              </Tooltip>
                            )}
                            {terminal.canInstall && !terminal.installed && (
                              <InstallLifecycleAction
                                action="install"
                                size="small"
                                iconOnly
                                tooltip={`安装 ${terminal.name}`}
                                aria-label={`安装 ${terminal.name}`}
                                disabled={lifecycleBusy}
                                loading={Boolean(actionBusyState(terminal, 'install').busy)}
                                onClick={() => void runAction(terminal, 'install')}
                              />
                            )}
                            {terminal.installed && managedLifecycle && (
                              <>
                                <InstallLifecycleAction
                                  action="update"
                                  size="small"
                                  iconOnly
                                  tooltip={`更新 ${terminal.name}`}
                                  aria-label={`更新 ${terminal.name}`}
                                  disabled={lifecycleBusy}
                                  loading={Boolean(updateState.busy)}
                                  onClick={() => void runAction(terminal, 'update')}
                                />
                                <InstallLifecycleAction
                                  action="uninstall"
                                  size="small"
                                  iconOnly
                                  tooltip={`卸载 ${terminal.name}`}
                                  aria-label={`卸载 ${terminal.name}`}
                                  disabled={lifecycleBusy}
                                  loading={Boolean(uninstallState.busy)}
                                  onClick={() => void runAction(terminal, 'uninstall')}
                                />
                              </>
                            )}
                          </>
                        );
                      })()}
                    </Space>
                  )}
                />
              );
            })}
          </div>
        </>
      ) : <Empty description="当前平台没有可管理的终端" />}
    </section>
  );
}
