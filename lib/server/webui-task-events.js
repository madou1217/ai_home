'use strict';

// 后台任务事件：**唯一的事件形状**（服务端产生、SSE 推送、WebUI 渲染）。
//
// 为什么不在 task 里塞一个自由文本 progress.label：账号活动的执行会经历
// 「读凭据 → 查投放 → 提交领取 → 解验证码 → 重试」多个阶段，页面需要知道
// **现在到底在做什么**，而不是只看到一个百分比。把这些阶段定义成事件，
// 任务快照只负责任务生命周期，事件流负责「执行到哪里了」。
//
// 契约（跨 Node 侧与 WebUI）：
//   { taskId, seq, at, phase, tone, message, account? }
//   * seq 在单个任务内单调递增，前端据此去重与排序；
//   * phase 是稳定的机器词表（见 TASK_EVENT_PHASES），UI 只做展示映射，
//     不解析 message；
//   * account 只带展示身份（displayNames / displayId / provider），**绝不**
//     把 acct_xxx 放进 message —— 队列面板显示账号时只能读这里；
//   * tone 只影响颜色：info | success | warning | error。
//
// 事件是**增量**，不是任务状态：任务终态仍以 task.status 为准。

const MAX_EVENTS_PER_TASK = 80;
const MAX_EVENT_MESSAGE_LENGTH = 500;
const MAX_DISPLAY_NAMES = 8;
const MAX_DISPLAY_VALUE_LENGTH = 200;
const EVENT_RETENTION_MS = 30 * 60 * 1000;

const TASK_EVENT_PHASES = Object.freeze({
  QUEUED: 'queued',
  ACCOUNT_STARTED: 'account_started',
  DISCOVERING: 'discovering',
  CLAIMING: 'claiming',
  CAPTCHA_REQUIRED: 'captcha_required',
  CAPTCHA_SOLVING: 'captcha_solving',
  CAPTCHA_SOLVED: 'captcha_solved',
  CAPTCHA_FAILED: 'captcha_failed',
  RATE_LIMITED: 'rate_limited',
  RETRYING: 'retrying',
  ACCOUNT_FINISHED: 'account_finished',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INFO: 'info'
});

const TASK_EVENT_TONES = new Set(['info', 'success', 'warning', 'error']);

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeDisplayNames(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const text = normalizeText(entry.value).slice(0, MAX_DISPLAY_VALUE_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ type: normalizeText(entry.type) || 'name', value: text });
    if (out.length >= MAX_DISPLAY_NAMES) break;
  }
  return out;
}

/** 账号展示身份：只允许 displayNames / displayId / provider，拒绝内部 ref 外溢。 */
function normalizeTaskAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = normalizeText(value.provider).toLowerCase();
  const displayNames = normalizeDisplayNames(value.displayNames);
  const displayId = normalizeText(value.displayId).slice(0, 32);
  if (!provider && displayNames.length === 0 && !displayId) return null;
  return {
    provider,
    displayId,
    displayNames
  };
}

/**
 * 创建一条任务事件。返回纯数据对象；hub 负责包上 type: 'task-event'。
 * 调用方不必自己算 seq/at（由 job manager 统一分配）。
 */
function createTaskEvent(input = {}) {
  const taskId = normalizeText(input.taskId);
  if (!taskId) return null;
  const seq = Math.max(1, Math.round(Number(input.seq) || 0));
  const at = Number(input.at) || Date.now();
  const phase = normalizeText(input.phase) || TASK_EVENT_PHASES.INFO;
  const toneRaw = normalizeText(input.tone).toLowerCase();
  const tone = TASK_EVENT_TONES.has(toneRaw) ? toneRaw : 'info';
  const message = normalizeText(input.message).slice(0, MAX_EVENT_MESSAGE_LENGTH);
  const account = normalizeTaskAccount(input.account);
  if (!message) return null;
  return {
    taskId,
    seq,
    at,
    phase,
    tone,
    message,
    ...(account ? { account } : {})
  };
}

/** 每个任务的事件环缓冲；超过上限时丢最旧的，内存不会随长任务无限增长。 */
function createTaskEventBuffer(options = {}) {
  const maxPerTask = Math.max(1, Number(options.maxPerTask) || MAX_EVENTS_PER_TASK);
  const retentionMs = Math.max(0, Number(options.retentionMs) || EVENT_RETENTION_MS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const byTask = new Map();

  function pruneTask(taskId) {
    const list = byTask.get(taskId);
    if (!list) return;
    const cutoff = now() - retentionMs;
    while (list.length > 0 && Number(list[0].at) < cutoff) list.shift();
    if (list.length === 0) byTask.delete(taskId);
  }

  function pruneAll() {
    for (const taskId of [...byTask.keys()]) pruneTask(taskId);
  }

  function append(event) {
    if (!event || !event.taskId) return;
    const list = byTask.get(event.taskId) || [];
    list.push(event);
    while (list.length > maxPerTask) list.shift();
    byTask.set(event.taskId, list);
    pruneTask(event.taskId);
  }

  function list(taskId) {
    pruneTask(taskId);
    return [...(byTask.get(taskId) || [])];
  }

  function listAll() {
    pruneAll();
    return [...byTask.values()]
      .flat()
      .sort((left, right) => Number(left.at || 0) - Number(right.at || 0) || Number(left.seq || 0) - Number(right.seq || 0));
  }

  function forget(taskId) {
    byTask.delete(taskId);
  }

  return { append, list, listAll, pruneAll, forget };
}

module.exports = {
  EVENT_RETENTION_MS,
  MAX_EVENTS_PER_TASK,
  TASK_EVENT_PHASES,
  TASK_EVENT_TONES,
  createTaskEvent,
  createTaskEventBuffer,
  normalizeDisplayNames,
  normalizeTaskAccount
};
