'use strict';

// **计划任务服务**（唯一实现处）：定义 CRUD + 调度循环 + 运行记录 + 手动触发。
//
// 调度语义（刻意保持可预测，不做 cron 全集）：
//   * `daily`    每天 HH:MM（本地时区）
//   * `weekly`   每周 <weekday> HH:MM
//   * `interval` 每 N 小时（可选 N 分钟粒度），锚点是**上次成功运行时间**，
//                没有历史时以任务创建时间为锚（避免刚建完就立刻触发）
// 补跑策略：进程重启/休眠导致错过时，下一次 tick **只补跑一次**（不会连打多轮），
// 之后按新锚点排下一次 —— 领取类动作重复执行会打上游，必须保守。
//
// 记录：每次运行写一条 record（含 trigger=manual|schedule、状态、摘要、错误），
// 由 store 按天裁剪（默认近 7 天），对应「默认显示近几天的就行」。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const { resolveAiHomeDir } = require('../runtime/aih-home');
const {
  readState,
  writeState,
  DEFAULT_RECORD_RETENTION_DAYS
} = require('./scheduled-task-store');
const {
  listScheduledEvents,
  parseEventId,
  describeEventAvailability,
  debounceMsForEvent,
  executeScheduledEvent
} = require('./scheduled-task-events');
const { acquireRun, runKey } = require('./scheduled-run-guard');
const { isActivityEventProbed } = require('./activity-run-keys');
const { parseCron, nextCronRunAt, describeCron } = require('./scheduled-task-cron');
const { getActivityAction, normalizeActivityParams } = require('../account/activity-claim');

const TICK_INTERVAL_MS = 30 * 1000;
const MAX_RUN_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 解析 `HH:MM`；非法返回 null。 */
function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalizeText(text));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 归一化调度描述；非法返回 null（调用方据此拒绝保存）。 */
function normalizeSchedule(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const kind = normalizeText(raw.kind).toLowerCase();
  if (kind === 'daily') {
    const clock = parseClock(raw.at);
    return clock ? { kind: 'daily', at: `${pad2(clock.hour)}:${pad2(clock.minute)}` } : null;
  }
  if (kind === 'weekly') {
    const clock = parseClock(raw.at);
    const weekday = Number(raw.weekday);
    if (!clock || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return { kind: 'weekly', weekday, at: `${pad2(clock.hour)}:${pad2(clock.minute)}` };
  }
  if (kind === 'interval') {
    const hours = Number(raw.hours);
    const minutes = raw.minutes === undefined || raw.minutes === null || raw.minutes === '' ? 0 : Number(raw.minutes);
    if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(minutes) || minutes < 0) return null;
    const totalMinutes = Math.round(hours * 60 + minutes);
    if (totalMinutes < 5 || totalMinutes > 24 * 60) return null;
    return { kind: 'interval', hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
  }
  if (kind === 'cron') {
    // 原生 5 段 cron：解析通过才算合法（不认的写法一律拒绝，不猜语义）。
    const expression = normalizeText(raw.expression);
    const cron = parseCron(expression);
    return cron ? { kind: 'cron', expression: cron.expression } : null;
  }
  return null;
}

function scheduleLabel(schedule) {
  if (!schedule) return '未设置';
  if (schedule.kind === 'daily') return `每天 ${schedule.at}`;
  if (schedule.kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${names[schedule.weekday] || '周'} ${schedule.at}`;
  }
  if (schedule.kind === 'interval') {
    const parts = [];
    if (schedule.hours) parts.push(`${schedule.hours} 小时`);
    if (schedule.minutes) parts.push(`${schedule.minutes} 分钟`);
    return `每 ${parts.join(' ') || '5 分钟'}`;
  }
  if (schedule.kind === 'cron') {
    const described = describeCron(schedule.expression);
    return described ? `${schedule.expression}（${described}）` : schedule.expression;
  }
  return '未设置';
}

/** 计算下一次运行时间（纯函数，便于核对）。`anchorMs` 用于 interval 的锚点。 */
function computeNextRunAt(schedule, fromMs, anchorMs) {
  const now = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  if (!schedule) return 0;
  if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
    const clock = parseClock(schedule.at);
    if (!clock) return 0;
    const base = new Date(now);
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), clock.hour, clock.minute, 0, 0);
    if (schedule.kind === 'daily') {
      if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate.getTime();
    }
    const weekday = Number(schedule.weekday);
    while (candidate.getDay() !== weekday || candidate.getTime() <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }
  if (schedule.kind === 'interval') {
    const stepMs = (Number(schedule.hours || 0) * 60 + Number(schedule.minutes || 0)) * 60 * 1000;
    if (stepMs <= 0) return 0;
    const anchor = Number.isFinite(Number(anchorMs)) && Number(anchorMs) > 0 ? Number(anchorMs) : now;
    if (anchor + stepMs > now) return anchor + stepMs;
    const elapsed = now - anchor;
    return anchor + (Math.floor(elapsed / stepMs) + 1) * stepMs;
  }
  if (schedule.kind === 'cron') {
    return nextCronRunAt(parseCron(schedule.expression), now);
  }
  return 0;
}

function serializeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    name: task.name,
    eventId: task.eventId,
    eventLabel: task.eventLabel || task.eventId,
    eventParams: task.eventParams && typeof task.eventParams === 'object' ? task.eventParams : {},
    schedule: task.schedule,
    scheduleLabel: scheduleLabel(task.schedule),
    enabled: task.enabled !== false,
    createdAt: Number(task.createdAt || 0),
    updatedAt: Number(task.updatedAt || 0),
    lastRunAt: Number(task.lastRunAt || 0),
    lastStatus: normalizeText(task.lastStatus),
    lastSummary: normalizeText(task.lastSummary),
    nextRunAt: Number(task.nextRunAt || 0),
    running: task.running === true
  };
}

/**
 * 创建计划任务服务。
 *
 * @param {object} [options]
 * @param {object} [options.fs] / [options.path] / [options.aiHomeDir]
 * @param {object} [options.deps]  透传给事件执行器（getActivityJobManager / accountEgressDeps …）
 * @param {function} [options.now]
 */
function createScheduledTaskService(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const deps = options.deps || {};
  const storeOptions = () => ({
    fs: fsImpl,
    path: pathImpl,
    ...(normalizeText(options.aiHomeDir) ? { aiHomeDir: options.aiHomeDir } : {}),
    now: now()
  });
  const running = new Map();
  let timer = null;
  let ticking = false;
  let lastTickAt = 0;

  function read() {
    return readState(storeOptions());
  }

  function write(state) {
    return writeState(state, storeOptions());
  }

  function findTask(state, taskId) {
    const id = normalizeText(taskId);
    return state.tasks.find((task) => task.id === id) || null;
  }

  function eventLabel(eventId) {
    const event = listScheduledEvents().find((item) => item.id === eventId);
    return event ? event.label : eventId;
  }

  /** 调度预览：校验 + 下次运行时间 + 中文解读（解读逻辑只在服务端一处）。 */
  function previewSchedule(input) {
    const schedule = normalizeSchedule(input);
    if (!schedule) return { ok: false, error: 'schedule_invalid' };
    const at = now();
    const nextRunAt = computeNextRunAt(schedule, at, at);
    if (!nextRunAt) return { ok: false, error: 'schedule_never_runs' };
    return { ok: true, schedule, label: scheduleLabel(schedule), nextRunAt };
  }

  function list() {
    const state = read();
    const events = listScheduledEvents().map((event) => ({
      ...event,
      available: describeEventAvailability(event).ok
    }));
    return {
      tasks: state.tasks.map(serializeTask),
      events,
      tickIntervalMs: TICK_INTERVAL_MS,
      recordRetentionDays: DEFAULT_RECORD_RETENTION_DAYS,
      schedulerRunning: Boolean(timer),
      lastTickAt
    };
  }

  function upsert(input = {}) {
    const eventId = normalizeText(input.eventId);
    const event = listScheduledEvents().find((item) => item.id === eventId);
    if (!event) return { ok: false, error: 'event_unknown' };
    const availability = describeEventAvailability(event);
    if (!availability.ok) return { ok: false, error: availability.reason };
    const schedule = normalizeSchedule(input.schedule);
    if (!schedule) return { ok: false, error: 'schedule_invalid' };
    const name = normalizeText(input.name) || event.label;
    const rawParams = input.eventParams && typeof input.eventParams === 'object' ? input.eventParams : {};
    if (event.kind === 'custom' && !normalizeText(rawParams.command)) {
      return { ok: false, error: 'custom_command_missing' };
    }
    // 活动参数按描述符 schema 校验并归一（未知 key 丢弃、非法值拒绝）。
    // 保存期就拒，而不是等定时触发时才在运行记录里报错。
    let eventParams = rawParams;
    if (event.kind === 'activity') {
      const parsed = parseEventId(eventId);
      const action = parsed ? getActivityAction(parsed.provider, parsed.actionId) : null;
      if (action) {
        const normalized = normalizeActivityParams(action, rawParams);
        if (!normalized.ok) return { ok: false, error: `event_params_invalid:${normalized.error}` };
        eventParams = normalized.params;
      }
    }
    const state = read();
    const timestamp = now();
    const existing = input.id ? findTask(state, input.id) : null;
    const enabled = input.enabled === undefined ? (existing ? existing.enabled !== false : true) : input.enabled !== false;
    const next = existing
      ? { ...existing, name, eventId, eventLabel: event.label, eventParams, schedule, enabled, updatedAt: timestamp }
      : {
        id: `stask-${nodeCrypto.randomUUID()}`,
        name,
        eventId,
        eventLabel: event.label,
        eventParams,
        schedule,
        enabled,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastRunAt: 0,
        lastStatus: '',
        lastSummary: '',
        running: false
      };
    next.nextRunAt = enabled ? computeNextRunAt(schedule, timestamp, next.lastRunAt || next.createdAt) : 0;
    const tasks = existing
      ? state.tasks.map((task) => (task.id === next.id ? next : task))
      : [...state.tasks, next];
    write({ ...state, tasks });
    return { ok: true, task: serializeTask(next) };
  }

  function remove(taskId) {
    const state = read();
    const target = findTask(state, taskId);
    if (!target) return { ok: false, error: 'task_not_found' };
    if (running.has(target.id)) return { ok: false, error: 'task_running' };
    write({ ...state, tasks: state.tasks.filter((task) => task.id !== target.id) });
    return { ok: true };
  }

  function setEnabled(taskId, enabled) {
    const state = read();
    const target = findTask(state, taskId);
    if (!target) return { ok: false, error: 'task_not_found' };
    const timestamp = now();
    const next = { ...target, enabled: enabled !== false, updatedAt: timestamp };
    next.nextRunAt = next.enabled ? computeNextRunAt(next.schedule, timestamp, next.lastRunAt || next.createdAt) : 0;
    write({ ...state, tasks: state.tasks.map((task) => (task.id === next.id ? next : task)) });
    return { ok: true, task: serializeTask(next) };
  }

  function records(query = {}) {
    const state = read();
    const days = Number.isFinite(Number(query.days)) ? Math.max(1, Number(query.days)) : DEFAULT_RECORD_RETENTION_DAYS;
    const cutoff = now() - days * 24 * 60 * 60 * 1000;
    const taskId = normalizeText(query.taskId);
    // **真分页**：先按时间窗过滤出全集（`total`），再按 offset/limit 切页 ——
    // 只返回一页却报 total 才是真分页；此前固定截断 200 条，翻页拿不到更早的记录。
    const all = state.records
      .filter((row) => Number(row.startedAt || 0) >= cutoff)
      .filter((row) => !taskId || row.taskId === taskId)
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
    const limit = Number.isFinite(Number(query.limit)) ? Math.max(1, Math.min(200, Number(query.limit))) : 20;
    const offset = Number.isFinite(Number(query.offset)) ? Math.max(0, Math.floor(Number(query.offset))) : 0;
    const page = all.slice(offset, offset + limit);
    return {
      records: page,
      days,
      total: all.length,
      limit,
      offset,
      hasMore: offset + page.length < all.length
    };
  }

  async function runTask(taskId, trigger = 'manual') {
    const state = read();
    const target = findTask(state, taskId);
    if (!target) return { ok: false, error: 'task_not_found' };
    if (running.has(target.id)) return { ok: false, error: 'task_running' };
    // **防抖 + 唯一**：同一事件（含参数指纹）同时只允许一个运行，且两次触发之间必须
    // 间隔声明里的窗口（见 scheduled-run-guard）。命中时**不静默丢弃**：写一条 skipped
    // 记录（界面可见），并照常按当前时间重排下一次。
    const guardKey = runKey(target.eventId, target.eventParams);
    // 探测（只读）正在打同一个上游：并发会限流（2026-10-31 实测 4 并发 3 个 429），
    // 所以本次按「跳过」记账 —— 不静默丢弃，下一次触发照常。
    if (isActivityEventProbed(target.eventId)) {
      const at = now();
      const skipped = {
        id: `srec-${nodeCrypto.randomUUID()}`,
        taskId: target.id,
        taskName: target.name,
        eventId: target.eventId,
        eventLabel: target.eventLabel || eventLabel(target.eventId),
        trigger: trigger === 'schedule' ? 'schedule' : 'manual',
        status: 'skipped',
        summary: '正在探测可领项，本次已跳过',
        error: 'probe_in_flight',
        startedAt: at,
        finishedAt: at
      };
      write({
        ...state,
        tasks: state.tasks.map((task) => (task.id === target.id
          ? {
            ...task,
            nextRunAt: task.enabled === false ? 0 : computeNextRunAt(task.schedule, at, at),
            lastStatus: 'skipped',
            lastSummary: skipped.summary,
            updatedAt: at
          }
          : task)),
        records: [skipped, ...state.records]
      });
      return { ok: true, skipped: true, reason: 'probe_in_flight', record: skipped };
    }
    const guard = acquireRun(guardKey, { debounceMs: debounceMsForEvent(target.eventId) });
    if (!guard.ok) {
      const at = now();
      const skipped = {
        id: `srec-${nodeCrypto.randomUUID()}`,
        taskId: target.id,
        taskName: target.name,
        eventId: target.eventId,
        eventLabel: target.eventLabel || eventLabel(target.eventId),
        trigger: trigger === 'schedule' ? 'schedule' : 'manual',
        status: 'skipped',
        summary: guard.reason === 'in_flight' ? '同一事件正在执行，本次已合并' : '距上次执行不足防抖窗口，本次已跳过',
        error: guard.reason,
        startedAt: at,
        finishedAt: at
      };
      write({
        ...state,
        tasks: state.tasks.map((task) => (task.id === target.id
          ? {
            ...task,
            nextRunAt: task.enabled === false ? 0 : computeNextRunAt(task.schedule, at, at),
            lastStatus: 'skipped',
            lastSummary: skipped.summary,
            updatedAt: at
          }
          : task)),
        records: [skipped, ...state.records]
      });
      return { ok: true, skipped: true, reason: guard.reason, record: skipped };
    }
    const startedAt = now();
    running.set(target.id, { trigger, startedAt });
    write({
      ...state,
      tasks: state.tasks.map((task) => (task.id === target.id ? { ...task, running: true, updatedAt: startedAt } : task))
    });
    let outcome = { status: 'error', summary: '', error: 'task_execution_failed' };
    try {
      outcome = await Promise.race([
        executeScheduledEvent({ eventId: target.eventId, params: target.eventParams, deps }),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'error', summary: '', error: 'task_timeout' }), MAX_RUN_MS))
      ]);
    } catch (error) {
      outcome = { status: 'error', summary: '', error: String((error && error.message) || error) };
    } finally {
      // 无论成功/失败/超时都释放运行权（防抖窗口从**结束时刻**起算）。
      try { guard.release(); } catch (_error) { /* 忽略 */ }
    }
    const finishedAt = now();
    running.delete(target.id);
    const latest = read();
    const current = findTask(latest, target.id) || target;
    const nextRunAt = current.enabled === false
      ? 0
      : computeNextRunAt(current.schedule, finishedAt, finishedAt);
    const record = {
      id: `srec-${nodeCrypto.randomUUID()}`,
      taskId: current.id,
      taskName: current.name,
      eventId: current.eventId,
      eventLabel: current.eventLabel || eventLabel(current.eventId),
      trigger: trigger === 'schedule' ? 'schedule' : 'manual',
      status: normalizeText(outcome.status) || 'error',
      summary: normalizeText(outcome.summary),
      error: normalizeText(outcome.error),
      // 失败归因单独存一份：`error` 是机器码（前端据此判红），`errorSummary`
      // 是「哪些账号、什么错误码」的人话，界面上优先展示它。
      errorSummary: normalizeText(outcome.errorSummary),
      startedAt,
      finishedAt
    };
    write({
      ...latest,
      tasks: latest.tasks.map((task) => (task.id === current.id
        ? {
          ...task,
          running: false,
          lastRunAt: finishedAt,
          lastStatus: record.status,
          lastSummary: record.summary || record.error,
          nextRunAt,
          updatedAt: finishedAt
        }
        : task)),
      records: [record, ...latest.records]
    });
    return { ok: true, record };
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    lastTickAt = now();
    try {
      const state = read();
      const due = state.tasks
        .filter((task) => task.enabled !== false && !running.has(task.id))
        .filter((task) => Number(task.nextRunAt || 0) > 0 && Number(task.nextRunAt || 0) <= lastTickAt)
        .sort((left, right) => Number(left.nextRunAt || 0) - Number(right.nextRunAt || 0));
      for (const task of due) {
        // 只补跑一次：跑完按当前时间重排，错过多次不会连打（领取类动作重复会打上游）。
        await runTask(task.id, 'schedule');
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    list,
    upsert,
    remove,
    setEnabled,
    records,
    previewSchedule,
    runTask,
    tick,
    start,
    stop,
    isRunning: (taskId) => running.has(normalizeText(taskId))
  };
}

module.exports = {
  TICK_INTERVAL_MS,
  MAX_RUN_MS,
  parseClock,
  normalizeSchedule,
  scheduleLabel,
  computeNextRunAt,
  serializeTask,
  createScheduledTaskService
};
