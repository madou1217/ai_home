import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import { isActiveWebUiTask, useWebUiTaskQueue } from '@/services/webui-task-queue';
import type { ClientPlatform, ClientTerminalItem, WebUiTask } from '@/types';
import InstallLifecycleAction, { type InstallLifecycleActionName as TerminalAction } from './InstallLifecycleAction';

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
    try {
      const response = await toolkitAPI.listTerminals();
      if (!response.ok) throw new Error('终端接口未返回可用结果');
      setPlatform(response.platform || '');
      setTerminals((response.terminals || []).filter((terminal) => terminal.platform === response.platform));
    } catch (error: unknown) {
      message.error(requestError(error, '读取终端清单失败'));
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
      message.info(`${terminal.name}${ACTION_LABELS[action]}任务已提交，按钮状态将跟随真实任务进度。`);
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
          <Space direction="vertical" size={4}>
            <Typography.Text>{plan.label || '将执行官方包管理器命令'}</Typography.Text>
            <Typography.Text code copyable>{plan.command}</Typography.Text>
          </Space>
        ),
        okText: '确认执行',
        cancelText: '取消',
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

  const unavailableActionTitle = (action: TerminalAction, terminal: ClientTerminalItem) => {
    if (terminal.default) return `${ACTION_LABELS[action]}不适用于系统默认终端`;
    return `未检测到可执行${ACTION_LABELS[action]}的当前平台官方包管理器`;
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-terminals-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">TERMINAL RUNTIME</div>
          <h2 id="toolkit-terminals-title">终端管理</h2>
          <p>仅显示当前平台（{platform ? PLATFORM_LABELS[platform] || platform : '当前主机'}）支持的终端；WebUI 可直接唤起已安装终端。安装、更新和卸载只调用对应平台的官方包管理器。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {loading && !terminals.length ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测终端" /></div>
      ) : terminals.length ? (
        <div className="toolkit-grid">
          {terminals.map((terminal) => (
            <article key={terminal.id} className={`toolkit-app-card ${terminal.installed ? 'installed' : 'uninstalled'}`}>
              <div>
                <div className="toolkit-card-header">
                  <div className="toolkit-card-title-group">
                    <div className="toolkit-terminal-glyph" aria-hidden="true">⌘</div>
                    <div>
                      <h3 className="toolkit-card-title">{terminal.name}</h3>
                      <Space size={4} wrap>
                        <Tag color={terminal.default ? 'blue' : 'default'}>{terminal.default ? '系统默认' : '可选终端'}</Tag>
                        <Tag color={terminal.installed ? 'success' : 'default'}>{terminal.installed ? '已安装' : '未安装'}</Tag>
                      </Space>
                    </div>
                  </div>
                </div>
                <p className="toolkit-card-body toolkit-terminal-description">{terminal.description}</p>
                <dl className="toolkit-card-body">
                  <div className="toolkit-detail-row">
                    <dt className="toolkit-detail-label">程序路径</dt>
                    <dd className="toolkit-detail-value">
                      <Typography.Text ellipsis={{ tooltip: terminal.executablePath || '由系统默认终端解析' }}>
                        {terminal.executablePath || '由系统默认终端解析'}
                      </Typography.Text>
                    </dd>
                  </div>
                  {terminal.sourceUrl ? (
                    <div className="toolkit-detail-row">
                      <dt className="toolkit-detail-label">官方文档</dt>
                      <dd className="toolkit-detail-value">
                        <a href={terminal.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              <div className="toolkit-card-actions">
                <Space size={6} wrap>
                  {(() => {
                    const activeTask = activeTaskFor(terminal);
                    const lifecycleBusy = terminalLifecycleBusy(terminal);
                    const updateState = actionBusyState(terminal, 'update');
                    const uninstallState = actionBusyState(terminal, 'uninstall');
                    const updateLabel = updateState.active || updateState.pending?.phase === 'submitted'
                      ? '更新中'
                      : updateState.pending
                        ? '准备更新'
                        : undefined;
                    const uninstallLabel = uninstallState.active || uninstallState.pending?.phase === 'submitted'
                      ? '卸载中'
                      : uninstallState.pending
                        ? '准备卸载'
                        : undefined;
                    return (
                      <>
                        {activeTask ? (
                          <Tag color="processing">
                            {ACTION_LABELS[(activeTask.action as TerminalAction) || 'update'] || '操作'}中
                            {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                          </Tag>
                        ) : null}
                        {terminal.canLaunch && (terminal.installed || terminal.default) && (
                          <Button
                            size="small"
                            icon={<ExportOutlined />}
                            loading={openingId === terminal.id}
                            disabled={lifecycleBusy}
                            onClick={() => void openTerminal(terminal)}
                          >
                            唤起终端
                          </Button>
                        )}
                        {terminal.canInstall && !terminal.installed && (
                          <InstallLifecycleAction
                            action="install"
                            size="small"
                            disabled={lifecycleBusy}
                            loading={Boolean(actionBusyState(terminal, 'install').busy)}
                            onClick={() => void runAction(terminal, 'install')}
                          />
                        )}
                        {!terminal.default && terminal.installed && (
                          <>
                            <InstallLifecycleAction
                              action="update"
                              size="small"
                              disabled={lifecycleBusy || !terminal.canUpdate}
                              title={terminal.canUpdate ? undefined : unavailableActionTitle('update', terminal)}
                              loading={Boolean(updateState.busy)}
                              onClick={() => void runAction(terminal, 'update')}
                            >
                              {updateLabel}
                            </InstallLifecycleAction>
                            <InstallLifecycleAction
                              action="uninstall"
                              size="small"
                              disabled={lifecycleBusy || !terminal.canUninstall}
                              title={terminal.canUninstall ? undefined : unavailableActionTitle('uninstall', terminal)}
                              loading={Boolean(uninstallState.busy)}
                              onClick={() => void runAction(terminal, 'uninstall')}
                            >
                              {uninstallLabel}
                            </InstallLifecycleAction>
                          </>
                        )}
                      </>
                    );
                  })()}
                </Space>
              </div>
            </article>
          ))}
        </div>
      ) : <Empty description="当前平台没有可管理的终端" />}
    </section>
  );
}
