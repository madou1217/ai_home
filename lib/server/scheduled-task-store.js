'use strict';

// **计划任务的持久化（唯一写入门）**。
//
// 形状（`<aiHomeDir>/run/scheduled-tasks/state.json`，0600，原子写）：
//   {
//     version: 1,
//     tasks:   [{ id, name, eventId, eventParams, schedule, enabled,
//                 createdAt, updatedAt, lastRunAt, lastStatus, nextRunAt }],
//     records: [{ id, taskId, taskName, eventId, status, startedAt, finishedAt,
//                 summary, error, jobId }]
//   }
//
// 为什么用 JSON 而不是 sqlite：与 `run/` 下其他运行态（harness 缓存、持久会话注册表、
// 出站池 state.json）同族，改动可回滚、可人工查看；这里的数据量有上限（任务几十条、
// 记录按天裁剪），不需要事务语义。
//
// 记录保留：默认只留最近 `DEFAULT_RECORD_RETENTION_DAYS` 天，且不超过 `MAX_RECORDS`
// 条（"默认显示近几天的就行"）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveAiHomeDir } = require('../runtime/aih-home');

const STATE_VERSION = 1;
const DEFAULT_RECORD_RETENTION_DAYS = 7;
const MAX_RECORDS = 800;
const MAX_TASKS = 200;

function resolveStateDir(options = {}) {
  const path = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim() || resolveAiHomeDir({});
  return path.join(aiHomeDir, 'run', 'scheduled-tasks');
}

function resolveStatePath(options = {}) {
  return (options.path || nodePath).join(resolveStateDir(options), 'state.json');
}

function emptyState() {
  return { version: STATE_VERSION, tasks: [], records: [] };
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: STATE_VERSION,
    tasks: Array.isArray(state.tasks) ? state.tasks.filter((task) => task && typeof task === 'object') : [],
    records: Array.isArray(state.records) ? state.records.filter((row) => row && typeof row === 'object') : []
  };
}

/** 裁剪记录：按时间窗 + 条数上限（新的在前）。 */
function pruneRecords(state, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const days = Number.isFinite(Number(options.retentionDays))
    ? Number(options.retentionDays)
    : DEFAULT_RECORD_RETENTION_DAYS;
  const cutoff = now - Math.max(1, days) * 24 * 60 * 60 * 1000;
  const kept = state.records
    .filter((row) => Number(row.finishedAt || row.startedAt || 0) >= cutoff)
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
    .slice(0, MAX_RECORDS);
  return { ...state, records: kept, tasks: state.tasks.slice(0, MAX_TASKS) };
}

function readState(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const file = resolveStatePath({ ...options, fs, path });
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pruneRecords(normalizeState(parsed), options);
  } catch (_error) {
    return emptyState();
  }
}

/** 原子写：同目录临时文件 + rename（避免半截文件被读到）。 */
function writeState(state, options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const dir = resolveStateDir({ ...options, fs, path });
  const file = resolveStatePath({ ...options, fs, path });
  const next = pruneRecords(normalizeState(state), options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `state.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_error) {
    // Windows 上 chmod 是 no-op；不要因此让保存失败。
  }
  return next;
}

module.exports = {
  STATE_VERSION,
  DEFAULT_RECORD_RETENTION_DAYS,
  MAX_RECORDS,
  MAX_TASKS,
  resolveStateDir,
  resolveStatePath,
  emptyState,
  pruneRecords,
  readState,
  writeState
};
