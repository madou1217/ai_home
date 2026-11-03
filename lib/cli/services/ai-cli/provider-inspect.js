'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../runtime/command-path');
const { getAiCliBinaryName } = require('./provider-registry');
const {
  collectNativeCliPathEntries,
  listProviderBinaryNames
} = require('./native-cli-installer');
const { resolveProviderCliExecutable } = require('../../../runtime/provider-cli-executable');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

/**
 * `aih <cli> version` 与 `aih <cli> sessions --history` 的事实来源：
 * - 版本：**直接问原生 CLI**（`<binary> --version`），不做任何猜测；找不到二进制就说找不到。
 * - 历史：读各 provider 自己的会话库（`lib/sessions/session-reader.js`），给出 id，
 *   让 `aih <cli> resume <id>` / `fork <id>` 有据可依。
 *
 * 关于「账号隔离」：cline / qoder / qodercn / kiro / grok 的会话存储在账号投影里，但
 * **账号隔离只针对凭据**——读取器会枚举每个账号的投影再合并（见 `session-reader.js` 的
 * `readAccountScopedProjects`），因此宿主级 `sessions --history` 一样能列出它们的会话。
 * 读不到只可能是「本机确实还没有该 CLI 的会话」。
 */

// CLI 解析链与**启动**同源：先在 PATH 里按 binaryName / 策略声明的别名找，再在
// 安装器声明的搜索根里找（例：ZCode CLI 只在 `<ZCode.app>/Contents/Resources/glm`，
// 永远不在 PATH 上），最后过一遍可执行适配（node bundle → 启动垫片）。
// 只查 PATH 会让「装在 App 里的 CLI」被误报成未安装。
function resolveInspectCliPath(provider, binaryName, deps = {}) {
  const pathImpl = deps.path || nodePath;
  const fsImpl = deps.fs || nodeFs;
  const processObj = deps.processObj || process;
  const resolveCommandPath = deps.resolveCommandPath || defaultResolveCommandPath;
  const names = [...new Set([
    binaryName,
    ...listProviderBinaryNames(provider, { processObj }),
    provider
  ].filter(Boolean))];
  const adapt = (found) => (found
    ? resolveProviderCliExecutable(provider, found, { fs: fsImpl, path: pathImpl, platform: processObj.platform })
    : '');
  for (const name of names) {
    try {
      const found = String(resolveCommandPath(name) || '').trim();
      if (found) return adapt(found);
    } catch (_error) { /* 继续下一个候选 */ }
  }
  let hostHomeDir = '';
  try {
    hostHomeDir = String(deps.hostHomeDir || resolveHostHomeDir({ processObj }) || '').trim();
  } catch (_error) {
    hostHomeDir = '';
  }
  let entries = [];
  try {
    entries = collectNativeCliPathEntries(provider, { path: pathImpl, fs: fsImpl, hostHomeDir, processObj }) || [];
  } catch (_error) {
    entries = [];
  }
  for (const entry of entries) {
    for (const name of names) {
      const candidate = pathImpl.join(String(entry || ''), name);
      try {
        if (fsImpl.existsSync(candidate) && fsImpl.statSync(candidate).isFile()) return adapt(candidate);
      } catch (_error) { /* 继续下一个候选 */ }
    }
  }
  return '';
}

function resolveProviderVersion(cliName, deps = {}) {
  const provider = String(cliName || '').trim().toLowerCase();
  const binaryName = deps.binaryName || getAiCliBinaryName(provider) || provider;
  const spawnSync = deps.spawnSync || nodeSpawnSync;
  const cliPath = deps.cliPath || resolveInspectCliPath(provider, binaryName, deps);
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

/**
 * 历史读取的「读不到」说明。
 *
 * 这里**不再**按 provider 名单提前判「账号隔离、拿不到」：会话存储对 cline / kiro / qoder /
 * grok 确实是按账号投影的，但账号隔离只针对凭据——aih 是所有账号的 owner，读取器会把每个账号
 * 的存储都枚举出来合并（见 `session-reader.js` 的 readAccountScopedProjects）。所以真正的
 * 「一条都没有」只有两种解释：本机还没用过这个 CLI，或它在 aih 之外、宿主也没留下痕迹。
 */
const HISTORY_EMPTY_HINT = '本机还没读到该 CLI 的会话（用它跑过一轮后就会出现）';

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
  if (!sessions.length) {
    return { ok: false, provider, reason: 'no_sessions', hint: HISTORY_EMPTY_HINT, sessions: [] };
  }
  sessions.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
    || right.updatedAt.localeCompare(left.updatedAt));
  return { ok: true, provider, source: 'host', total: sessions.length, sessions: sessions.slice(0, limit) };
}

module.exports = {
  listProviderSessionHistory,
  resolveProviderVersion
};
