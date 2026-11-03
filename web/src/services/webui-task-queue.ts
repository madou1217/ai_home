import { useSyncExternalStore } from 'react';
import { listActiveWebUiTasks, watchWebUiTasks } from './api';
import type { WebUiTask } from '@/types';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RECENT_EVENT_RETENTION_MS = 5 * 60 * 1000;

export type WebUiTaskStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling' | 'offline';

export interface WebUiTaskQueueSnapshot {
  tasks: WebUiTask[];
  recentTasks: WebUiTask[];
  streamStatus: WebUiTaskStreamStatus;
  lastEventAt: number;
}

type TaskListener = () => void;

const listeners = new Set<TaskListener>();
const activeTasks = new Map<string, WebUiTask>();
const recentTasks = new Map<string, { task: WebUiTask; seenAt: number }>();
let eventSource: EventSource | null = null;
let pollTimer: number | null = null;
let started = false;
let generation = 0;
let snapshot: WebUiTaskQueueSnapshot = {
  tasks: [],
  recentTasks: [],
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

function publishSnapshot() {
  const now = Date.now();
  for (const [id, entry] of recentTasks) {
    if (now - entry.seenAt > RECENT_EVENT_RETENTION_MS) recentTasks.delete(id);
  }
  snapshot = {
    ...snapshot,
    tasks: sortTasks(activeTasks.values()),
    recentTasks: sortTasks([...recentTasks.values()].map((entry) => entry.task))
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
    };
    if (payload.type === 'snapshot' && Array.isArray(payload.tasks)) {
      applyActiveSnapshot(payload.tasks);
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
  pollTimer = window.setInterval(() => {
    void hydrate(localGeneration);
    publishSnapshot();
  }, 5000);
  eventSource = watchWebUiTasks();
  eventSource.onopen = () => setStreamStatus('connected');
  eventSource.onerror = () => setStreamStatus('reconnecting');
  eventSource.onmessage = handleMessage;
}

function stop() {
  if (!started) return;
  started = false;
  generation += 1;
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
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
