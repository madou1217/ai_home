'use strict';

const crypto = require('node:crypto');

// 已结束的同步任务在内存里留一段时间：页面刷新、断线重连后还能看到刚结束的结果。
const DEFAULT_JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_FINISHED_JOBS = 20;
const ITEM_DONE = new Set(['succeeded', 'failed']);

function newJobId() {
  return `sync_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 订阅源同步的任务化执行器（WebUI 用）。
 *
 * 拉一个订阅可能要十几秒（上游慢、403、几百个节点），批量同步更不能让 HTTP 请求一直挂着：
 * start 立刻返回任务，之后每个订阅源各自出结果，经 onChange 推给界面（SSE），一个源失败不影响其它源。
 *
 * - 并发是全局的：所有任务共用一条队列、最多 concurrency 个源同时拉；
 * - 同一个源同一时间只拉一次：几个任务都包含它时共享同一次拉取的结果；
 * - 只依赖 service.syncSource(id) 这一个端口（那里负责落库与「客户端拉取触发的同步」合并）。
 */
class SourceSyncRunner {
  constructor(options = {}) {
    if (!options.service || typeof options.service.syncSource !== 'function') {
      throw new Error('source_sync_runner_service_required');
    }
    this.service = options.service;
    this.now = options.now || (() => Date.now());
    this.concurrency = Math.max(1, Number(options.concurrency) || 4);
    this.retentionMs = Number(options.retentionMs ?? DEFAULT_JOB_RETENTION_MS);
    this.jobs = new Map();
    // 每个源最近一次的结果（只在内存里；重启后从「上次同步时间」重新开始）。
    this.sourceStates = new Map();
    // 排队或正在拉取的源 → { promise, started }，几个任务共享。
    this.runs = new Map();
    this.queue = [];
    this.active = 0;
    this.listeners = new Set();
  }

  onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emitJob(job) {
    job.updatedAt = this.now();
    const event = { type: 'job', job: this.serializeJob(job) };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (_error) {
        // 一个推送订阅出错不能影响同步本身或其它订阅。
      }
    }
  }

  _prune() {
    const cutoff = this.now() - this.retentionMs;
    const finished = [...this.jobs.values()].filter((job) => job.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt);
    finished.forEach((job, index) => {
      if (job.finishedAt <= cutoff || index >= MAX_FINISHED_JOBS) this.jobs.delete(job.id);
    });
  }

  serializeJob(job) {
    const items = [...job.items.values()].map((item) => ({ ...item }));
    const failed = items.filter((item) => item.state === 'failed').length;
    const done = items.filter((item) => ITEM_DONE.has(item.state)).length;
    return {
      id: job.id,
      taskName: job.taskName,
      status: job.status,
      counts: { total: items.length, done, failed, succeeded: done - failed },
      items,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt
    };
  }

  getJob(id) {
    const job = this.jobs.get(String(id || ''));
    return job ? this.serializeJob(job) : null;
  }

  /** 首屏 / 重连：每个源当前状态 + 最近的任务（新的在前）。 */
  snapshot() {
    this._prune();
    return {
      sources: Object.fromEntries(this.sourceStates),
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((job) => this.serializeJob(job))
    };
  }

  /** 包含这个源、还没结束的任务。 */
  _activeJobsFor(sourceId) {
    return [...this.jobs.values()].filter((job) => !job.finishedAt && job.items.has(sourceId));
  }

  _setSourceState(sourceId, state) {
    this.sourceStates.set(sourceId, { ...state, updatedAt: this.now() });
  }

  _updateItems(sourceId, patch) {
    for (const job of this._activeJobsFor(sourceId)) {
      const item = job.items.get(sourceId);
      // 已经有结果的条目不再被改写（共享拉取时，结果只写一次）。
      if (ITEM_DONE.has(item.state)) continue;
      Object.assign(item, patch);
      if (patch.state === 'running') job.status = 'running';
      this._settleIfDone(job);
      this._emitJob(job);
    }
  }

  _settleIfDone(job) {
    const items = [...job.items.values()];
    if (job.finishedAt || items.some((item) => !ITEM_DONE.has(item.state))) return;
    const failed = items.filter((item) => item.state === 'failed').length;
    job.status = !failed ? 'succeeded' : failed === items.length ? 'failed' : 'partial';
    job.finishedAt = this.now();
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.active += 1;
      // 任务自己兜住所有异常；这里再接一层，绝不把 rejection 漏成进程级未处理异常。
      Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          this.active -= 1;
          this._pump();
        });
    }
  }

  /** 安排一次拉取；这个源已经在排队或在拉时复用那一次。 */
  _schedule(sourceId) {
    if (this.runs.has(sourceId)) return this.runs.get(sourceId).promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const run = { promise, started: false };
    this.runs.set(sourceId, run);
    this.queue.push(async () => {
      run.started = true;
      const startedAt = this.now();
      let outcome = null;
      try {
        this._setSourceState(sourceId, { state: 'running', startedAt });
        this._updateItems(sourceId, { state: 'running', startedAt });
        let result;
        try {
          result = await this.service.syncSource(sourceId);
        } catch (error) {
          result = { ok: false, error: error.code || 'subscription_sync_failed', message: error.message };
        }
        const ok = Boolean(result && result.ok !== false);
        outcome = {
          state: ok ? 'succeeded' : 'failed',
          startedAt,
          finishedAt: this.now(),
          count: Number((result && result.count) || 0),
          error: ok ? '' : String((result && result.error) || 'subscription_sync_failed'),
          message: ok ? '' : String((result && result.message) || '')
        };
      } catch (error) {
        outcome = {
          state: 'failed',
          startedAt,
          finishedAt: this.now(),
          count: 0,
          error: 'subscription_sync_failed',
          message: String((error && error.message) || error || '')
        };
      } finally {
        // 无论哪一步出错，这个源都必须离开「排队 / 同步中」，否则以后再也点不动。
        this.runs.delete(sourceId);
        this._setSourceState(sourceId, outcome);
        this._updateItems(sourceId, outcome);
        resolve(outcome);
      }
    });
    this._pump();
    return promise;
  }

  /**
   * 开始一个同步任务（entries: [{ id, name }]），立刻返回任务快照。
   * 已经在别的任务里排队 / 拉取的源直接共享那一次的结果。
   */
  start(entries, { taskName = '同步订阅源' } = {}) {
    this._prune();
    const list = [];
    const seen = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = entry && entry.id ? String(entry.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: String(entry.name || id) });
    }
    if (!list.length) return { ok: false, error: 'subscription_source_required' };
    const createdAt = this.now();
    const job = {
      id: newJobId(),
      taskName: String(taskName),
      status: 'queued',
      items: new Map(),
      createdAt,
      updatedAt: createdAt,
      finishedAt: null
    };
    for (const entry of list) {
      const running = this.runs.get(entry.id)?.started;
      const state = running ? this.sourceStates.get(entry.id) : null;
      job.items.set(entry.id, {
        sourceId: entry.id,
        name: entry.name,
        state: running ? 'running' : 'queued',
        startedAt: state ? state.startedAt : null,
        finishedAt: null,
        count: 0,
        error: '',
        message: ''
      });
      if (!running) this._setSourceState(entry.id, { state: 'queued', startedAt: null });
    }
    if ([...job.items.values()].some((item) => item.state === 'running')) job.status = 'running';
    this.jobs.set(job.id, job);
    this._emitJob(job);
    for (const entry of list) void this._schedule(entry.id);
    return { ok: true, job: this.serializeJob(job) };
  }

  /** 单个源：它已经在某个进行中的任务里时直接返回那个任务（reused），不再新建。 */
  startOne(entry) {
    const id = entry && entry.id ? String(entry.id) : '';
    if (!id) return { ok: false, error: 'subscription_source_required' };
    const [active] = this._activeJobsFor(id);
    if (active) return { ok: true, reused: true, job: this.serializeJob(active) };
    return this.start([{ id, name: entry.name }], { taskName: `同步 ${entry.name || id}` });
  }
}

module.exports = {
  DEFAULT_JOB_RETENTION_MS,
  MAX_FINISHED_JOBS,
  SourceSyncRunner
};
