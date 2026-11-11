'use strict';

// OAuth Job 公开快照的进程内缓存 + Go 持久化通道。
//
// 为什么要有这一层：
//   * Node 仍是 12 类 Provider 的登录执行者，Job 只活在内存里（终态 15 分钟后清理），
//     服务一重启，WebUI 就查不到「刚才那次登录到底成了没有」；
//   * Go 的 oauth_jobs 表是跨重启的存储真相，但它不该知道 Node 的 Job 内部字段
//     （PID、日志、PKCE 等），所以这里只投影**公开快照**（状态/时间/错误码/终态账号结果）。
//
// 纪律：
//   * 推送是 best-effort：失败只记 dirty，由 flush() 在下一轮重试，绝不抛出；
//   * 只推变化（status + updatedAt + errorCode 相同就不重复写）；
//   * 不缓存任何凭据：JobRecord 里没有 Token/state/PKCE。

const DEFAULT_RETRY_MS = 60_000;

// 只有终态才有 finished_at；pending/processing 的完成时间没有意义。
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

// Node 的 Job 状态 → Go 的公开状态。
// running 覆盖「等待回调」与「正在写账号」两种内部阶段，持久化时统一记 pending：
// 重启后它们都会被 Rehydrate 标成 expired，没必要区分。
const STATUS_MAP = Object.freeze({
  running: 'pending',
  succeeded: 'completed',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired'
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value) {
  return STATUS_MAP[normalizeText(value).toLowerCase()] || '';
}

function isoTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value).toISOString();
}

// Go 的 cli_account_id 是正整数别名；0 等价于「还没分配」，不推送。
function normalizeCliAccountId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * 把内部 Job 投影成 Go 的公开快照。
 *
 * @returns {object|null} null 表示这条 Job 还不该持久化（缺 id/状态无法映射）。
 */
function toJobRecord(job) {
  if (!job || typeof job !== 'object') return null;
  const jobId = normalizeText(job.id || job.jobId);
  const providerId = normalizeText(job.provider).toLowerCase();
  const status = normalizeStatus(job.status);
  if (!jobId || !providerId || !status) return null;
  const createdAt = Number(job.createdAt) || Date.now();
  const updatedAt = Number(job.updatedAt) || createdAt;
  // 账号结果只在成功后成立：reauth 作业在 pending 阶段也带着目标 accountRef，
  // 那是 target_ref 而不是结果，不能提前写成 account_ref 污染快照。
  const succeeded = status === 'completed';
  const accountRef = succeeded ? normalizeText(job.accountRef) : '';
  const cliAccountId = succeeded ? normalizeCliAccountId(job.cliAccountId) : 0;
  const finishedAt = TERMINAL_STATUSES.has(status) ? isoTime(job.finishedAt) : '';
  return {
    job_id: jobId,
    provider_id: providerId,
    purpose: job.reauth || job._reauthTargetRef ? 'reauth' : 'register',
    target_ref: normalizeText(job.accountRef || job._reauthTargetRef),
    status,
    created_at: isoTime(createdAt),
    updated_at: isoTime(updatedAt),
    expires_at: isoTime(job.expiresAt),
    error_code: normalizeText(job.errorCode || job.error && job.error.code),
    error_message: normalizeText(typeof job.error === 'string' ? job.error : job.error && job.error.message).slice(0, 500),
    owner: 'node',
    source: 'node',
    ...(accountRef ? { account_ref: accountRef } : {}),
    ...(cliAccountId ? { cli_account_id: cliAccountId } : {}),
    ...(finishedAt ? { finished_at: finishedAt } : {})
  };
}

/**
 * @param {object} options
 * @param {(record: object) => Promise<any>} options.put Go 写入
 * @param {() => Promise<any>} options.list Go 列表（hydrate 用）
 * @param {number} [options.retryMs]
 * @param {() => number} [options.now]
 */
function createGoOAuthJobStore(options = {}) {
  const put = typeof options.put === 'function' ? options.put : null;
  const list = typeof options.list === 'function' ? options.list : null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retryMs = Number.isFinite(Number(options.retryMs)) && Number(options.retryMs) >= 0
    ? Number(options.retryMs)
    : DEFAULT_RETRY_MS;

  /** @type {Map<string, object>} 最近一次已知快照（内存读缓存） */
  const records = new Map();
  /** @type {Map<string, {record: object, retryAt: number}>} 推送失败待重试 */
  const dirty = new Map();
  /** @type {Map<string, string>} 已成功推送的签名，避免重复写 */
  const pushed = new Map();
  let hydrating = null;

  function signature(record) {
    // 终态账号字段也参与签名：Late 补上的 accountRef/cliAccountId 必须再推一次。
    return [
      record.status,
      record.updated_at,
      record.error_code,
      record.error_message,
      record.account_ref || '',
      record.cli_account_id || 0,
      record.finished_at || '',
      record.owner || '',
      record.source || ''
    ].join('|');
  }

  function remember(record) {
    if (!record) return;
    records.set(record.job_id, record);
  }

  async function flushRecord(record) {
    if (!put) return false;
    // 先乐观登记签名再发请求：同一条快照在飞行中再次 record 时不能重复推送
    // （OAuth 进度通知是高频的，重复写会把 Go 打满）。
    const sig = signature(record);
    pushed.set(record.job_id, sig);
    const result = await put(record).catch(() => null);
    if (result && (result.ok === true || result.status === 200)) {
      dirty.delete(record.job_id);
      return true;
    }
    if (pushed.get(record.job_id) === sig) pushed.delete(record.job_id);
    dirty.set(record.job_id, { record, retryAt: now() + retryMs });
    return false;
  }

  /** 记录一条 Job 变化（异步推送；同一 Job 的推送按最后一次快照收敛）。 */
  function record(job) {
    const snapshot = toJobRecord(job);
    if (!snapshot) return null;
    remember(snapshot);
    if (signature(snapshot) === pushed.get(snapshot.job_id)) return snapshot;
    // 不 await：OAuth 主流程不能被持久化拖慢或拖失败。
    flushRecord(snapshot).catch(() => {});
    return snapshot;
  }

  /** 用 Go 的历史记录回填内存（重启后 WebUI 还能看到终态）。 */
  function hydrateFromRecords(items) {
    let loaded = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.job_id) continue;
      remember(item);
      pushed.set(item.job_id, signature(item));
      loaded += 1;
    }
    return loaded;
  }

  async function hydrate() {
    if (!list) return 0;
    if (hydrating) return hydrating;
    hydrating = Promise.resolve()
      .then(() => list())
      .then((result) => {
        if (!result || !result.ok) return 0;
        return hydrateFromRecords(result.data);
      })
      .catch(() => 0)
      .finally(() => { hydrating = null; });
    return hydrating;
  }

  /** 重试 dirty 条目；无参调用可被定时器/对账轮触发。 */
  async function flush() {
    const due = now();
    const pending = [];
    for (const [jobId, entry] of dirty) {
      if (entry.retryAt <= due) pending.push(entry.record);
      void jobId;
    }
    let pushedCount = 0;
    for (const item of pending) {
      if (await flushRecord(item)) pushedCount += 1;
    }
    return pushedCount;
  }

  function get(jobId) {
    const id = normalizeText(jobId);
    return id ? records.get(id) || null : null;
  }

  function listRecords() {
    return Array.from(records.values());
  }

  return { record, hydrate, hydrateFromRecords, flush, get, list: listRecords, toJobRecord };
}

module.exports = { createGoOAuthJobStore, toJobRecord, DEFAULT_RETRY_MS };
