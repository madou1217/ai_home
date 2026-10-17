'use strict';

const nodeFs = require('node:fs');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../runtime/command-path');
const { getAiCliBinaryName } = require('./provider-registry');

/**
 * `aih <cli> version` 与 `aih <cli> sessions --history` 的事实来源：
 * - 版本：**直接问原生 CLI**（`<binary> --version`），不做任何猜测；找不到二进制就说找不到。
 * - 历史：读各 provider 自己的会话库（`lib/sessions/session-reader.js`），给出 id，
 *   让 `aih <cli> resume <id>` / `fork <id>` 有据可依。
 *
 * 边界（如实说明，不假装覆盖）：cline / qoder / qodercn / kiro 的会话**按账号隔离**，
 * 宿主级读取拿不到 → 明确返回 `account_scoped`，让用户去 `aih <cli> <id> sessions` 或 WebUI 会话历史。
 */

const ACCOUNT_SCOPED_HISTORY_PROVIDERS = Object.freeze(['cline', 'qoder', 'qodercn', 'kiro']);

function resolveProviderVersion(cliName, deps = {}) {
  const provider = String(cliName || '').trim().toLowerCase();
  const binaryName = deps.binaryName || getAiCliBinaryName(provider) || provider;
  const resolveCommandPath = deps.resolveCommandPath || defaultResolveCommandPath;
  const spawnSync = deps.spawnSync || nodeSpawnSync;
  let cliPath = '';
  try {
    cliPath = String(resolveCommandPath(binaryName) || '').trim();
  } catch (_error) {
    cliPath = '';
  }
  if (!cliPath) {
    return { ok: false, provider, binaryName, cliPath: '', reason: 'cli_not_found', version: '' };
  }
  let output = '';
  try {
    const result = spawnSync(cliPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...(deps.env || process.env), NO_COLOR: '1' }
    });
    output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`;
  } catch (error) {
    output = String((error && error.message) || error);
  }
  const version = output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/experimentalwarning|trace-warnings/i.test(line)) || '';
  return { ok: true, provider, binaryName, cliPath, version, reason: '' };
}

function listProviderSessionHistory(cliName, options = {}) {
  const provider = String(cliName || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
  const readProjects = options.readProjectsFromHostByProviders;
  if (typeof readProjects !== 'function') {
    return { ok: false, provider, reason: 'history_unavailable', sessions: [] };
  }
  let projects = [];
  try {
    projects = readProjects([provider], options.readerOptions || {}) || [];
  } catch (_error) {
    projects = [];
  }
  const sessions = [];
  for (const project of projects) {
    for (const session of (project && project.sessions) || []) {
      const id = String((session && session.id) || '').trim();
      if (!id) continue;
      sessions.push({
        id,
        projectPath: String((project && project.projectPath) || (project && project.path) || '').trim(),
        title: String((session && (session.title || session.summary)) || '').trim(),
        updatedAt: String((session && (session.updatedAt || session.lastActiveAt || session.createdAt)) || '').trim()
      });
    }
  }
  if (!sessions.length && ACCOUNT_SCOPED_HISTORY_PROVIDERS.includes(provider)) {
    return { ok: false, provider, reason: 'account_scoped', sessions: [] };
  }
  sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { ok: true, provider, source: 'host', total: sessions.length, sessions: sessions.slice(0, limit) };
}

module.exports = {
  ACCOUNT_SCOPED_HISTORY_PROVIDERS,
  listProviderSessionHistory,
  resolveProviderVersion
};
