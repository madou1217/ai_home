'use strict';

/**
 * CodeBuddy 家族的**目录信任记忆**。
 *
 * 事故形态（用户 2026-10-31）：第一次在某个目录里 `aih codebuddy 1` / `aih codebuddycn 1`
 * 会弹 `Do you trust the files in this folder?`，而回答只写进**当前这个账号投影**的
 * `settings.json`。换一个账号（投影不同）、或者换到国内站/国际站，同一目录又问一遍；
 * 每个账号都要重新选一次。
 *
 * CLI 自己的判定（2.178.1 二进制内实测）是
 *   needsAuthorization(dir) = trustAll || trustedDirectories.some(p => matchTrustPattern(p, dir))
 * 读写的是 `<configDir>/settings.json` 的 `trustedDirectories`。所以"记住"这件事在
 * aih 侧只需要做一件事：**把用户已经做过的决定带给还没被问到的账号**——
 *
 *   启动前扫一遍家族所有 settings（宿主四个配置根 + 各账号投影），
 *   如果当前目录已经被其中任何一份信任，就把那条 pattern 补进本次启动的 configDir。
 *
 * 刻意**不**替用户自动信任新目录：第一次进一个目录仍然由 CLI 问、用户自己答，
 * aih 只负责不要让人为同一个目录反复答第二遍、第三遍。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { FAMILY_PROVIDERS } = require('./codebuddy-family-layouts');
const { getProviderStoragePolicy } = require('./provider-storage-policy');
const { writeFileAtomic } = require('./atomic-file-write');

const SETTINGS_FILE = 'settings.json';

function familyConfigDirNames() {
  const names = [];
  for (const provider of FAMILY_PROVIDERS) {
    const policy = getProviderStoragePolicy(provider);
    const nativeRoot = policy && Array.isArray(policy.nativeRoot) ? policy.nativeRoot : [];
    if (nativeRoot.length === 1 && !names.includes(String(nativeRoot[0]))) names.push(String(nativeRoot[0]));
  }
  return names;
}

function readSettings(fs, filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return null;
  }
}

function readTrustedDirectories(fs, filePath) {
  const settings = readSettings(fs, filePath);
  if (!settings || !Array.isArray(settings.trustedDirectories)) return [];
  return settings.trustedDirectories.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeDir(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '') || '';
}

/**
 * 复刻 CLI 的 pattern 匹配（只需覆盖 CLI 自己会写的那几种形态）：
 *   `<dir>`           精确
 *   `<dir>/**`        该目录及其全部子目录（CLI 的「Trust folder and all subdirectories」）
 *   `<parent>/**`     父目录范围（「Trust parent folder」）
 *   `**`              全部
 * 其它形态（含问号/方括号等复杂 glob）按"不匹配"处理：宁可多问一次，
 * 也不要把一条自己没看懂的 pattern 当成授权扩散出去。
 */
function matchesTrustedDirectory(pattern, directory) {
  const raw = String(pattern || '').trim();
  const dir = normalizeDir(directory);
  if (!raw || !dir) return false;
  if (raw === '**') return true;

  const normalized = normalizeDir(raw);
  if (!normalized.includes('*')) return normalized === dir;
  if (!normalized.endsWith('/**')) return false;
  const base = normalizeDir(normalized.slice(0, -3));
  if (!base || base.includes('*')) return false;
  return dir === base || dir.startsWith(`${base}/`);
}

/**
 * 家族里所有写得到信任决定的 settings 路径：宿主四个配置根 + 各账号投影。
 * 账号投影形如 `<aiHomeDir>/run/auth-projections/<provider>/<accountRef>/<configDir>`。
 */
function listFamilySettingsPaths(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const configDirs = familyConfigDirNames();
  const paths = [];

  if (hostHomeDir) {
    for (const dirName of configDirs) {
      paths.push(pathImpl.join(hostHomeDir, dirName, SETTINGS_FILE));
    }
  }

  if (aiHomeDir) {
    const projectionsRoot = pathImpl.join(aiHomeDir, 'run', 'auth-projections');
    for (const provider of FAMILY_PROVIDERS) {
      const providerRoot = pathImpl.join(projectionsRoot, provider);
      let accountRefs = [];
      try { accountRefs = fs.readdirSync(providerRoot); } catch (_error) { accountRefs = []; }
      for (const accountRef of accountRefs) {
        for (const dirName of configDirs) {
          paths.push(pathImpl.join(providerRoot, accountRef, dirName, SETTINGS_FILE));
        }
      }
    }
  }

  return paths;
}

/**
 * 找出"这个目录已经被家族里某个账号信任过"的那条 pattern。
 *
 * @returns {string} 命中的 pattern；没有则返回 ''
 */
function trustSpecificity(pattern, directory) {
  const raw = String(pattern || '').trim();
  if (raw === '**') return -1;
  if (!raw.includes('*')) return Number.MAX_SAFE_INTEGER;
  return normalizeDir(raw.slice(0, -3)).length;
}

function findInheritedTrustPattern(options = {}) {
  const fs = options.fs || nodeFs;
  const directory = String(options.directory || '').trim();
  if (!directory) return '';
  // 取**最窄**的那条已授权 pattern：有的账号被点过「Trust parent folder」甚至整片
  // /Users，如果照抄那条，等于把一个账号的放大授权扩散给其它账号。只继承刚好覆盖
  // 这个目录的最小范围。
  let best = '';
  for (const settingsPath of listFamilySettingsPaths(options)) {
    for (const pattern of readTrustedDirectories(fs, settingsPath)) {
      if (!matchesTrustedDirectory(pattern, directory)) continue;
      if (!best || trustSpecificity(pattern, directory) > trustSpecificity(best, directory)) best = pattern;
    }
  }
  return best;
}

/**
 * 把家族里已经做过的目录信任决定补给本次启动的 configDir。
 *
 * 幂等：当前 configDir 已经覆盖该目录时什么都不写。
 *
 * @returns {{ ok: boolean, changed: boolean, pattern: string, reason?: string }}
 */
function seedInheritedFolderTrust(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const configDir = String(options.configDir || '').trim();
  const directory = String(options.directory || '').trim();
  const empty = { ok: false, changed: false, pattern: '' };
  if (!configDir || !directory) return { ...empty, reason: 'inputs_missing' };

  const settingsPath = pathImpl.join(configDir, SETTINGS_FILE);
  const existing = readTrustedDirectories(fs, settingsPath);
  if (existing.some((pattern) => matchesTrustedDirectory(pattern, directory))) {
    return { ok: true, changed: false, pattern: '' };
  }

  const pattern = findInheritedTrustPattern({ ...options, fs, path: pathImpl, directory });
  if (!pattern) return { ok: true, changed: false, pattern: '' };

  try {
    fs.mkdirSync(configDir, { recursive: true });
    const settings = readSettings(fs, settingsPath) || {};
    const next = {
      ...settings,
      trustedDirectories: [...existing, pattern]
    };
    writeFileAtomic(fs, settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, changed: true, pattern };
  } catch (error) {
    return { ok: false, changed: false, pattern, reason: String((error && (error.code || error.message)) || error) };
  }
}

module.exports = {
  familyConfigDirNames,
  listFamilySettingsPaths,
  matchesTrustedDirectory,
  findInheritedTrustPattern,
  seedInheritedFolderTrust
};
