import { useEffect, useMemo, useRef, useState } from 'react';
import { Progress } from 'antd';
import { CloseOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { useWebUiTaskQueue, type WebUiTaskStreamStatus } from '@/services/webui-task-queue';
import type { WebUiTask } from '@/types';
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

function statusLabel(task: WebUiTask) {
  if (task.status === 'queued') return '排队中';
  if (task.status === 'running') return '执行中';
  return task.status || '执行中';
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
  const [expanded, setExpanded] = useState(false);

  const { tasks, streamStatus } = useWebUiTaskQueue();

  useEffect(() => {
    if (!expanded) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded]);

  const activeTasks = useMemo(() => tasks, [tasks]);

  useEffect(() => {
    if (!activeTasks.length) setExpanded(false);
  }, [activeTasks.length]);

  if (!activeTasks.length) return null;

  return (
    <div
      ref={rootRef}
      className={`webui-task-queue${expanded ? ' is-expanded' : ''}`}
      data-task-count={activeTasks.length}
    >
      <button
        type="button"
        className="webui-task-queue-trigger"
        aria-expanded={expanded}
        aria-label={expanded ? '收起后台任务队列' : `打开后台任务队列，共 ${activeTasks.length} 个任务`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="webui-task-queue-trigger-icon" aria-hidden="true">
          {expanded ? <CloseOutlined /> : <LoadingOutlined spin />}
        </span>
        <span className="webui-task-queue-count">{activeTasks.length}</span>
        <span className="webui-task-queue-trigger-label">后台任务</span>
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
          {activeTasks.map((task) => {
            const percent = Math.round(Number(task.progress?.percent || 0));
            return (
              <article className="webui-task-queue-item" key={task.id}>
                <div className="webui-task-queue-item-heading">
                  <strong title={taskName(task)}>{taskName(task)}</strong>
                  <span>{statusLabel(task)}</span>
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
                  status={task.status === 'queued' ? 'normal' : 'active'}
                />
                <div className="webui-task-queue-item-detail">
                  <span>{task.progress?.label || '等待状态更新'}</span>
                  <span>{updatedLabel(Number(task.updatedAt || 0))}</span>
                </div>
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
    </div>
  );
}
