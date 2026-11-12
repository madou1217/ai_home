import { useSyncExternalStore } from 'react';
import { listActiveWebUiTasks, watchWebUiTasks } from './api';
import type { WebUiTask, WebUiTaskEvent } from '@/types';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RECENT_EVENT_RETENTION_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_TASK = 60;

export type WebUiTaskStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling' | 'offline';

export interface WebUiTaskQueueSnapshot {
  tasks: WebUiTask[];
  recentTasks: WebUiTask[];
  /** 所有任务的阶段事件（按 at / seq 排序）；组件按 taskId 分组渲染。 */
  events: WebUiTaskEvent[];
  streamStatus: WebUiTaskStreamStatus;
  lastEventAt: number;
}

type TaskListener = () => void;

const listeners = new Set<TaskListener>();
const activeTasks = new Map<string, WebUiTask>();
const recentTasks = new Map<string, { task: WebUiTask; seenAt: number }>();
const eventsByTask = new Map<string, WebUiTaskEvent[]>();
let eventSource: EventSource | null = null;
let started = false;
let generation = 0;
let snapshot: WebUiTaskQueueSnapshot = {
  tasks: [],
  recentTasks: [],
  events: [],
  streamStatus: 'connecting',
  lastEventAt: 0
};

function isActiveTask(task: WebUiTask | null | undefined) {
  return Boolean(task && ACTIVE_STATUSES.has(String(task.status || '').toLowerCase()));
}

function sortTasks(tasks: Iterable<WebUiTask>) {
  return [...tasks].sort((left, right) => (
    Number(left.createdAt || 0) - Number(right.createdAt || 0)
      || String(left.id).localeCompare(String(right.id))
  ));
}

function sortEvents(events: Iterable<WebUiTaskEvent>) {
  return [...events].sort((left, right) => (
    Number(left.at || 0) - Number(right.at || 0) || Number(left.seq || 0) - Number(right.seq || 0)
  ));
}

function normalizeEvent(input: WebUiTaskEvent): WebUiTaskEvent | null {
  const taskId = String(input && input.taskId || '').trim();
  const seq = Math.max(1, Math.round(Number(input && input.seq) || 0));
  const message = String(input && input.message || '').trim();
  if (!taskId || !message) return null;
  const tone = String(input && input.tone || 'info').toLowerCase();
  return {
    taskId,
    seq,
    at: Number(input && input.at) || Date.now(),
    phase: String(input && input.phase || 'info'),
    tone: (tone === 'success' || tone === 'warning' || tone === 'error' ? tone : 'info') as WebUiTaskEvent['tone'],
    message,
    ...(input && input.account ? { account: input.account } : {})
  };
}

function applyTaskEvent(input: WebUiTaskEvent, options: { publish?: boolean } = {}) {
  const event = normalizeEvent(input);
  if (!event) return;
  const list = eventsByTask.get(event.taskId) || [];
  if (list.some((entry) => entry.seq === event.seq)) return;
  list.push(event);
  list.sort((left, right) => Number(left.at || 0) - Number(right.at || 0) || Number(left.seq || 0) - Number(right.seq || 0));
  while (list.length > MAX_EVENTS_PER_TASK) list.shift();
  eventsByTask.set(event.taskId, list);

  // 事件先到、任务快照后到是正常的（SSE 增量）；先就地更新进度，
  // 让页面在下一帧就能看到「执行到哪里」，而不是等轮询兜底。
  const active = activeTasks.get(event.taskId);
  if (active) {
    activeTasks.set(event.taskId, {
      ...active,
      updatedAt: Math.max(Number(active.updatedAt || 0), event.at),
      progress: {
        ...active.progress,
        stage: event.phase,
        label: event.message,
        ...(event.account ? { account: event.account } : {})
      }
    });
  }
  snapshot = { ...snapshot, lastEventAt: event.at };
  if (options.publish !== false) publishSnapshot();
}

function applyEventSnapshot(input: WebUiTaskEvent[]) {
  // 重连时一次补几十条事件：先全部入库，最后只通知一次 React，避免逐条渲染。
  for (const event of input) applyTaskEvent(event, { publish: false });
  publishSnapshot();
}

function pruneEvents(now: number) {
  for (const [taskId, list] of eventsByTask) {
    const last = list[list.length - 1];
    if (last && now - Number(last.at || 0) > RECENT_EVENT_RETENTION_MS) eventsByTask.delete(taskId);
  }
}

function publishSnapshot() {
  const now = Date.now();
  for (const [id, entry] of recentTasks) {
    if (now - entry.seenAt > RECENT_EVENT_RETENTION_MS) recentTasks.delete(id);
  }
  pruneEvents(now);
  snapshot = {
    ...snapshot,
    tasks: sortTasks(activeTasks.values()),
    recentTasks: sortTasks([...recentTasks.values()].map((entry) => entry.task)),
    events: sortEvents([...eventsByTask.values()].flat())
  };
  listeners.forEach((listener) => listener());
}

function setStreamStatus(streamStatus: WebUiTaskStreamStatus) {
  if (snapshot.streamStatus === streamStatus) return;
  snapshot = { ...snapshot, streamStatus };
  listeners.forEach((listener) => listener());
}

function applyActiveSnapshot(tasks: WebUiTask[]) {
  activeTasks.clear();
  tasks.filter(isActiveTask).forEach((task) => activeTasks.set(task.id, task));
  publishSnapshot();
}

function applyTask(task: WebUiTask) {
  const id = String(task.id || '').trim();
  if (!id) return;
  recentTasks.set(id, { task, seenAt: Date.now() });
  if (isActiveTask(task)) activeTasks.set(id, task);
  else activeTasks.delete(id);
  snapshot = { ...snapshot, lastEventAt: Date.now() };
  publishSnapshot();
  if (!isActiveTask(task) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aih:webui-task-completed', { detail: task }));
  }
}

async function hydrate(localGeneration: number) {
  try {
    const active = await listActiveWebUiTasks();
    if (!started || localGeneration !== generation) return;
    applyActiveSnapshot(active);
    if (snapshot.streamStatus !== 'connected') setStreamStatus('polling');
  } catch (_error) {
    if (started && localGeneration === generation && snapshot.streamStatus !== 'connected') {
      setStreamStatus('offline');
    }
  }
}

function handleMessage(event: MessageEvent) {
  try {
    const payload = JSON.parse(String(event.data || '{}')) as {
      type?: string;
      task?: WebUiTask;
      tasks?: WebUiTask[];
      event?: WebUiTaskEvent;
      events?: WebUiTaskEvent[];
    };
    if (payload.type === 'snapshot' && Array.isArray(payload.tasks)) {
      applyActiveSnapshot(payload.tasks);
      return;
    }
    if (payload.type === 'event-snapshot' && Array.isArray(payload.events)) {
      applyEventSnapshot(payload.events);
      return;
    }
    if (payload.type === 'task-event' && payload.event) {
      applyTaskEvent(payload.event);
      return;
    }
    if (payload.type === 'task' && payload.task) applyTask(payload.task);
  } catch (_error) {
    // Ignore malformed heartbeat/frames; polling remains the recovery path.
  }
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  generation += 1;
  const localGeneration = generation;
  setStreamStatus('connecting');
  void hydrate(localGeneration);
  eventSource = watchWebUiTasks();
  eventSource.onopen = () => setStreamStatus('connected');
  eventSource.onerror = () => setStreamStatus('reconnecting');
  eventSource.onmessage = handleMessage;
}

function stop() {
  if (!started) return;
  started = false;
  generation += 1;
  eventSource?.close();
  eventSource = null;
}

function subscribe(listener: TaskListener) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stop();
  };
}

function getSnapshot() {
  return snapshot;
}

export function useWebUiTaskQueue() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isActiveWebUiTask(task: WebUiTask | null | undefined) {
  return isActiveTask(task);
}
