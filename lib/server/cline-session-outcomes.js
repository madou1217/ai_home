'use strict';

// cline 会话级结果 → 账号结果桶（健康统计的第三个来源）。
//
// 为什么需要：健康统计原本只有「上游 attempt 结果」一种证据。只用原生 CLI 驱动的账号
// （`aih cline <id>`，不经过网关）没有任何 attempt，状态条因此永远是空的。cline 自己
// 会把会话终态写进会话记录（`sessions/<id>/<id>.json` 的 `status` / `exit_code` /
// `ended_at`，2026-10-15 实测 3.0.71），这是该账号可观测的、非猜测的结果证据。
//
// 口径（与 Go FailureKind 闭集对齐，绝不发明新分类）：
//   * status=completed/success/…  → success
//   * status=failed/error         → unclassified（闭集里的「其他」）
//   * status=cancelled/取消 / running / 未知 → 不记（没有账号健康证据）
// 归属复用共享会话库的注册表作用域（lib/usage/cline-usage-ownership.js）：未归属的会话
// 一律不写结果桶，宁可少记也不张冠李戴。
//
// 幂等：每个 (sessionId, status, ended_at) 只记一次，游标持久化在 app-state KV
// （幂等 / 未归属不推进游标 / 定时轮询由 native-session-outcome-poller.js 的模板负责）。

const nodePath = require('node:path');
const { createNativeSessionOutcomePoller, DEFAULT_POLL_INTERVAL_MS } = require('./native-session-outcome-poller');
const { createClineUsageOwnership } = require('../usage/cline-usage-ownership');
const { discoverClineUsageFiles } = require('../usage/model-usage-scanner');

const STORE_KEY = 'cline-session-outcomes';

const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'ok', 'done']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 会话记录的终态 → 结果标签；'' 表示不记。纯函数，便于单测与复用。 */
function classifyClineSessionOutcome(record = {}) {
  const status = normalizeText(record && record.status).toLowerCase();
  if (!status) return '';
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (FAILURE_STATUSES.has(status)) return 'unclassified';
  return '';
}

/** 本轮的 cline 会话结果观察（模板见 native-session-outcome-poller.js）。 */
function collectClineSessionOutcomes({ fs: fsImpl, path: pathImpl, aiHomeDir, hostHomeDir }) {
  if (!aiHomeDir || !hostHomeDir) return [];
  const ownership = createClineUsageOwnership({ fs: fsImpl, aiHomeDir });
  const observations = [];
  for (const recordPath of discoverClineUsageFiles({ fs: fsImpl, path: pathImpl, hostHomeDir })) {
    let record = null;
    try {
      record = JSON.parse(fsImpl.readFileSync(recordPath, 'utf8'));
    } catch (_error) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const sessionId = normalizeText(record.session_id) || pathImpl.basename(recordPath, '.json');
    const endedAtMs = toTimestampMs(record.ended_at);
    const startedAtMs = toTimestampMs(record.started_at);
    const outcome = classifyClineSessionOutcome(record);
    observations.push({
      key: sessionId,
      marker: `${record.status}:${endedAtMs}`,
      outcome,
      atMs: endedAtMs || startedAtMs || Date.now(),
      // 只有要记的观察才需要归属（注册表读取有成本，但这里按会话只算一次）。
      accountRef: outcome
        ? normalizeText(ownership.resolve({ sessionId, cwd: normalizeText(record.cwd), startedAtMs }).accountRef)
        : ''
    });
  }
  return observations;
}

function createClineSessionOutcomePoller(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || nodePath;
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const hostHomeDir = normalizeText(options.hostHomeDir);
  return createNativeSessionOutcomePoller({
    fs: fsImpl,
    aiHomeDir: hostHomeDir ? aiHomeDir : '',
    nodeAccountOutcomes: options.nodeAccountOutcomes,
    intervalMs: options.intervalMs,
    storeKey: normalizeText(options.storeKey) || STORE_KEY,
    collect: () => collectClineSessionOutcomes({ fs: fsImpl, path: pathImpl, aiHomeDir, hostHomeDir })
  });
}

module.exports = {
  classifyClineSessionOutcome,
  collectClineSessionOutcomes,
  createClineSessionOutcomePoller,
  DEFAULT_POLL_INTERVAL_MS
};
