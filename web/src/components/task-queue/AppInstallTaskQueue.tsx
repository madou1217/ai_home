import { useEffect, useMemo, useRef, useState } from 'react';
import { Progress } from 'antd';
import { DownOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { listActiveWebUiTasks, watchWebUiTasks } from '@/services/api';
import type { WebUiTask } from '@/types';
import './AppInstallTaskQueue.css';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function isActiveTask(task: WebUiTask | null | undefined) {
  return Boolean(task && !TERMINAL_STATUSES.has(String(task.status || '').toLowerCase()));
}

function taskName(task: WebUiTask) {
  if (task.taskName) return task.taskName;
  if (task.kind === 'terminal') return `${task.provider || task.appId} 终端操作`;
  return `${task.provider || task.appId} ${task.kind === 'desktop' ? 'Desktop' : 'CLI'} 安装`;
}

function statusLabel(task: WebUiTask) {
  if (task.status === 'queued') return '排队中';
  if (task.status === 'running') return '执行中';
  return task.status || '执行中';
}

function mergeTaskMap(current: Map<string, WebUiTask>, task: WebUiTask) {
  const next = new Map(current);
  if (isActiveTask(task)) next.set(task.id, task);
  else next.delete(task.id);
  return next;
}

export default function AppInstallTaskQueue() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tasks, setTasks] = useState<Map<string, WebUiTask>>(new Map());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const active = await listActiveWebUiTasks();
        if (!disposed) {
          setTasks(new Map(active.filter(isActiveTask).map((task) => [task.id, task])));
        }
      } catch (_error) {
        // SSE reconnects itself; a later hydration retry will recover the list.
      }
    };
    void load();
    const pollTimer = window.setInterval(() => { void load(); }, 5000);
    const eventSource = watchWebUiTasks();
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}')) as {
          type?: string;
          task?: WebUiTask;
          tasks?: WebUiTask[];
        };
        if (payload.type === 'snapshot' && Array.isArray(payload.tasks)) {
          setTasks(new Map(payload.tasks.filter(isActiveTask).map((task) => [task.id, task])));
          return;
        }
        if (payload.type !== 'task' || !payload.task) return;
        setTasks((current) => mergeTaskMap(current, payload.task as WebUiTask));
        if (!isActiveTask(payload.task) && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('aih:webui-task-completed', { detail: payload.task }));
        }
      } catch (_error) {
        // Ignore malformed heartbeat/frames.
      }
    };
    return () => {
      disposed = true;
      window.clearInterval(pollTimer);
      eventSource.close();
    };
  }, []);

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

  const activeTasks = useMemo(
    () => [...tasks.values()].sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)),
    [tasks]
  );

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
          {expanded ? <DownOutlined /> : <LoadingOutlined spin />}
        </span>
        <span className="webui-task-queue-count">{activeTasks.length}</span>
        <span className="webui-task-queue-trigger-label">后台任务</span>
      </button>

      <section className="webui-task-queue-panel" aria-label="后台任务队列" aria-live="polite">
        <header className="webui-task-queue-header">
          <div>
            <span className="webui-task-queue-kicker">BACKGROUND TASKS</span>
            <strong>后台任务队列</strong>
          </div>
          <span>{activeTasks.length} 个执行中</span>
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
                <Progress
                  percent={percent}
                  size="small"
                  showInfo
                  status={task.status === 'queued' ? 'normal' : 'active'}
                />
                <div className="webui-task-queue-item-detail">
                  <span>{task.progress?.label || '等待状态更新'}</span>
                  <span>{task.source === 'terminal' ? '终端' : '应用'}</span>
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
