'use strict';

// **计划任务的事件目录与执行器**（唯一实现处）。
//
// 事件来自**声明**，不写 provider 名单：
//   * `activity:<provider>:<actionId>` —— provider 描述符 `activity.actions[]` 里的账号活动
//     （如 zcode 的「领臭鸡蛋」、qoder 的「签到」）。目录由
//     `lib/account/activity-claim` 的 `listActivityProviders/listActivityActions` 推出，
//     所以新增 provider/动作只改描述符，这里和前端的下拉框都自动跟着变。
//   * `custom-command` —— 用户自定义命令（`params.command` + 可选 `params.cwd`）。
//     以服务进程身份执行，属于运维便利功能；界面上必须明确标注。
//
// 执行**复用**既有执行器：活动走 `account-activity-job-manager`（因此计划触发的领取
// 同样出现在统一任务队列里、有实时进度），命令走一次性 spawn 并回收退出码与输出尾巴。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
const {
  listActivityProviders,
  listActivityActions,
  getActivityAction,
  normalizeActivityParams,
  resolveActivityTargets,
  runActivityClaim
} = require('../account/activity-claim');
const {
  summarizeActivityResults,
  formatActivitySummary
} = require('../account/activity-claim/outcomes');
const { listAccountCredentialRecords } = require('./account-credential-store');
const { resolveAiHomeDir } = require('../runtime/aih-home');
const { DEFAULT_DEBOUNCE_MS } = require('./scheduled-run-guard');

const CUSTOM_COMMAND_EVENT_ID = 'custom-command';
const CUSTOM_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVITY_JOB_POLL_MS = 700;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function providerLabel(provider) {
  return String(provider || '').trim().toUpperCase() || '未知';
}

/** 事件目录：**只列 provider 声明了 `schedulable` 的动作** + 自定义命令。 */
function listScheduledEvents() {
  const events = [];
  for (const provider of listActivityProviders()) {
    // 只有这里要 schema：计划任务编辑器据此渲染参数表单。
    for (const action of listActivityActions(provider, { includeParams: true })) {
      if (action.schedulable !== true) continue;
      events.push({
        id: `activity:${provider}:${action.id}`,
        kind: 'activity',
        provider,
        actionId: action.id,
        label: `${providerLabel(provider)} · ${action.label}`,
        description: action.description || `对 ${providerLabel(provider)} 的全部账号执行「${action.label}」`,
        debounceMs: Number(action.scheduleDebounceMs) > 0 ? Number(action.scheduleDebounceMs) : DEFAULT_DEBOUNCE_MS,
        // 参数是**声明**：调度器只存值、按 type 归一，不认识具体 key。
        params: Array.isArray(action.params) ? action.params : [],
        supportsProbe: action.supportsProbe === true
      });
    }
  }
  events.push({
    id: CUSTOM_COMMAND_EVENT_ID,
    kind: 'custom',
    label: '自定义命令',
    description: '以服务进程身份执行一条 shell 命令（参数里给出 command）',
    debounceMs: 0
  });
  return events;
}

/** 该事件的防抖窗口（来自 provider 声明；未声明用默认值）。 */
function debounceMsForEvent(eventId) {
  const parsed = parseEventId(eventId);
  if (!parsed) return DEFAULT_DEBOUNCE_MS;
  if (parsed.kind === 'custom') return 0;
  const action = listActivityActions(parsed.provider).find((item) => item.id === parsed.actionId) || null;
  const declared = Number(action && action.scheduleDebounceMs);
  return Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : DEFAULT_DEBOUNCE_MS;
}

function parseEventId(eventId) {
  const raw = normalizeText(eventId);
  if (!raw) return null;
  if (raw === CUSTOM_COMMAND_EVENT_ID) return { id: raw, kind: 'custom' };
  const parts = raw.split(':');
  if (parts[0] !== 'activity' || parts.length < 3) return null;
  return { id: raw, kind: 'activity', provider: parts[1], actionId: parts.slice(2).join(':') };
}

/** 该事件当前是否可执行（活动类：provider 得声明该动作）。 */
function describeEventAvailability(event) {
  const parsed = parseEventId(event && event.id);
  if (!parsed) return { ok: false, reason: 'event_unknown' };
  if (parsed.kind === 'custom') return { ok: true };
  const actions = listActivityActions(parsed.provider).map((action) => action.id);
  if (!actions.includes(parsed.actionId)) return { ok: false, reason: 'event_action_not_declared' };
  return { ok: true };
}


async function runCustomCommand(params = {}, options = {}) {
  const command = normalizeText(params.command);
  if (!command) return { status: 'error', error: 'custom_command_missing', summary: '' };
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CUSTOM_COMMAND_TIMEOUT_MS;
  const cwd = normalizeText(params.cwd) || process.cwd();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('/bin/sh', ['-c', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'error', error: `custom_command_spawn_failed:${String((error && error.message) || error)}`, summary: '' });
      return;
    }
    let out = '';
    let err = '';
    const append = (chunk, target) => {
      const text = String(chunk || '');
      if (target === 'out') out = (out + text).slice(-4000);
      else err = (err + text).slice(-4000);
    };
    if (child.stdout && child.stdout.on) child.stdout.on('data', (chunk) => append(chunk, 'out'));
    if (child.stderr && child.stderr.on) child.stderr.on('data', (chunk) => append(chunk, 'err'));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_error) { /* 忽略 */ }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'error', error: `custom_command_failed:${String((error && error.message) || error)}`, summary: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code == null ? 1 : Number(code);
      resolve({
        status: exitCode === 0 ? 'ok' : 'error',
        error: exitCode === 0 ? '' : `custom_command_exit_${exitCode}`,
        summary: (out || err).trim().split('\n').slice(-3).join(' | ').slice(0, 400)
      });
    });
  });
}

/**
 * 执行一次事件。
 *
 * @param {object} input
 * @param {string} input.eventId
 * @param {object} [input.params]        自定义事件的参数（command/cwd）
 * @param {object} [input.deps]          { fs, path, aiHomeDir, accountEgressDeps, getActivityJobManager, runActivityClaim }
 * @param {function} [input.onProgress]  进度回调（活动任务转发队列进度）
 * @returns {Promise<{status: string, summary: string, error: string, results?: object[]}>}
 */
async function executeScheduledEvent(input = {}) {
  const parsed = parseEventId(input.eventId);
  const deps = input.deps || {};
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  if (!parsed) return { status: 'error', summary: '', error: 'event_unknown' };
  if (parsed.kind === 'custom') return runCustomCommand(input.params, { spawnImpl: deps.spawnImpl });

  const availability = describeEventAvailability({ id: parsed.id });
  if (!availability.ok) return { status: 'error', summary: '', error: availability.reason };

  const aiHomeDir = normalizeText(deps.aiHomeDir) || resolveAiHomeDir({});
  const action = getActivityAction(parsed.provider, parsed.actionId);
  if (!action) return { status: 'error', summary: '', error: 'event_action_not_declared' };

  // 参数按描述符 schema 归一：调度器只负责「存下来 → 交给类型适配器」，
  // 不认识 accountRefs / planKind 的语义（见 lib/account/activity-claim/params.js）。
  const normalized = normalizeActivityParams(action, input.params);
  if (!normalized.ok) return { status: 'error', summary: '', error: normalized.error };

  const listRecords = typeof deps.listAccountCredentialRecords === 'function'
    ? deps.listAccountCredentialRecords
    : listAccountCredentialRecords;
  let targets = [];
  try {
    targets = listRecords(fsImpl, aiHomeDir, parsed.provider)
      .map((record) => ({ provider: parsed.provider, record }));
  } catch (error) {
    return { status: 'error', summary: '', error: `account_list_failed:${String((error && error.message) || error)}` };
  }
  if (targets.length === 0) return { status: 'skipped', summary: 'no_accounts', error: '' };

  const resolved = resolveActivityTargets(action, normalized.params, targets);
  if (resolved.targets.length === 0 && resolved.unknownAccountRefs.length === 0) {
    // 选了账号但一个都不属于本 provider：明确说清楚，不要伪装成「没账号」。
    return { status: 'skipped', summary: 'no_selected_accounts', error: '' };
  }
  // 已被删除的账号写成一条失败结果（fail-loud）：任务变红，用户才知道该清理任务。
  const missingTargets = resolved.unknownAccountRefs
    .map((accountRef) => ({ provider: parsed.provider, record: { accountRef }, missing: true }));
  const selectedTargets = [...resolved.targets, ...missingTargets];

  const executeClaim = typeof deps.runActivityClaim === 'function' ? deps.runActivityClaim : runActivityClaim;
  const accountEgressDeps = deps.accountEgressDeps;
  const execute = async ({ provider, record, missing }) => {
    if (missing === true) {
      return {
        provider,
        accountRef: record.accountRef,
        actionId: parsed.actionId,
        status: 'error',
        error: 'account_not_found'
      };
    }
    try {
      const result = await executeClaim({
        fs: fsImpl,
        path: pathImpl,
        aiHomeDir,
        provider,
        record,
        actionId: parsed.actionId,
        params: normalized.params,
        ...(accountEgressDeps ? { accountEgressDeps } : {})
      });
      return result && typeof result === 'object'
        ? result
        : { provider, accountRef: record.accountRef, actionId: parsed.actionId, status: 'error', error: 'activity_empty_result' };
    } catch (error) {
      return { provider, accountRef: record.accountRef, actionId: parsed.actionId, status: 'error', error: String((error && error.message) || error) };
    }
  };

  const getManager = typeof deps.getActivityJobManager === 'function' ? deps.getActivityJobManager : null;
  if (getManager) {
    // 走统一任务队列：计划触发的领取在界面上与手动触发完全一样（有实时进度）。
    const started = getManager().start({
      providers: [parsed.provider],
      actionId: parsed.actionId,
      actionLabel: action.label || parsed.actionId,
      params: normalized.params,
      targets: selectedTargets,
      execute
    });
    if (!started || started.ok !== true) {
      return { status: 'error', summary: '', error: (started && started.error) || 'activity_start_failed' };
    }
    const jobId = started.job && started.job.id;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVITY_JOB_POLL_MS));
      const job = getManager().getJob(jobId);
      if (!job) return { status: 'error', summary: '', error: 'activity_job_lost' };
      if (typeof input.onProgress === 'function') input.onProgress(job);
      if (job.status === 'succeeded' || job.status === 'failed') {
        // 摘要与错误归因都来自 job 的结构化汇总，不在这里重新数 status ——
        // 旧实现按 `status === 'ok'` 计数，而活动结果里没有 'ok'，摘要恒为 0/N。
        const summary = job.summary || summarizeActivityResults(job.results);
        return {
          status: job.status === 'succeeded' ? 'ok' : 'error',
          summary: formatActivitySummary(summary),
          error: job.error || '',
          errorSummary: job.errorSummary || summary.errorSummary || '',
          results: job.results
        };
      }
    }
  }
  const results = [];
  for (const target of selectedTargets) results.push(await execute(target));
  const summary = summarizeActivityResults(results);
  return {
    status: summary.failed === 0 ? 'ok' : 'error',
    summary: formatActivitySummary(summary),
    error: summary.failed > 0 ? 'activity_partial_failure' : '',
    errorSummary: summary.errorSummary || '',
    results
  };
}

module.exports = {
  CUSTOM_COMMAND_EVENT_ID,
  CUSTOM_COMMAND_TIMEOUT_MS,
  listScheduledEvents,
  debounceMsForEvent,
  parseEventId,
  describeEventAvailability,
  summarizeActivityResults,
  runCustomCommand,
  executeScheduledEvent
};
