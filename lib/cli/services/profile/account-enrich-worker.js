'use strict';

// 列表补算的 worker 侧：主线程只负责画，读凭据 / 刷新索引 / 用量标签都在这里做。
// 协议：{ id, tasks: [{ provider, accountRef, indexRow }] } → { id, ok, results: [...] }

const { parentPort, workerData } = require('node:worker_threads');

// worker 一旦打开 sqlite 就会往 stderr 打 ExperimentalWarning；TUI 按绝对行号重绘，
// 这一行会让整屏串行。必须在加载任何 sqlite 相关模块之前装过滤。
require('../../../runtime/sqlite-warning-filter').installSqliteWarningFilter(process);

const { enrichAccountView } = require('./enrich-account');

let deps = null;

function getDeps() {
  if (deps) return deps;
  const fs = require('node:fs');
  const path = require('node:path');
  const { createProfileLayoutService } = require('../profile/layout');
  const { AI_CLI_CONFIGS } = require('../ai-cli/provider-registry');
  const { createHeavyProfileDeps } = require('./heavy-profile-deps');
  const data = workerData || {};
  const layout = createProfileLayoutService({
    fs,
    path,
    aiHomeDir: data.aiHomeDir,
    hostHomeDir: data.hostHomeDir
  });
  deps = createHeavyProfileDeps({
    fs,
    path,
    processObj: process,
    aiHomeDir: data.aiHomeDir,
    getProfileDir: layout.getProfileDir,
    cliConfigs: AI_CLI_CONFIGS
  });
  return deps;
}

function enrichTask(task) {
  const provider = String(task && task.provider || '').trim();
  const accountRef = String(task && task.accountRef || '').trim();
  if (!provider || !accountRef) return null;
  let result = null;
  try {
    result = enrichAccountView({
      provider,
      accountRef,
      indexRow: task.indexRow || null,
      ...getDeps()
    });
  } catch (_error) {
    // 单个账号算不出来：返回 null，主线程保留索引态那一版，下一轮再试。
    return null;
  }
  return result ? { provider, accountRef, ...result } : null;
}

parentPort.on('message', (message) => {
  const payload = message && typeof message === 'object' ? message : {};
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  let results = [];
  try {
    results = tasks.map(enrichTask).filter(Boolean);
  } catch (_error) {
    results = [];
  }
  parentPort.postMessage({ id: payload.id, ok: true, results });
});
