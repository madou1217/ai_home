'use strict';

// 远程账号备份配置（<aiHomeDir>/backup/config.json，0600）。
//
// 这里只存「备份到哪里、用什么策略」，绝不存 SSH 密码本身：
//   - identityFile 指向本机私钥路径；
//   - 需要密码时只存环境变量名（passwordEnv），运行时从进程环境读取。
//
// 目标按 id 唯一。id 默认由 user@host 派生，用户可以用 --name 覆盖。
// 新增策略（例如 webdav）只需在 strategies/index.js 注册，配置层不写死策略名。

const crypto = require('node:crypto');
const path = require('node:path');

const BACKUP_CONFIG_VERSION = 1;
const BACKUP_STATE_VERSION = 1;
const BACKUP_DIR_NAME = 'backup';
const BACKUP_CONFIG_FILE = 'config.json';
const BACKUP_STATE_FILE = 'state.json';
const DEFAULT_INTERVAL_MINUTES = 360;
const DEFAULT_DEBOUNCE_SECONDS = 30;
const DEFAULT_REMOTE_DIR = '~/.aih-backup';
const DEFAULT_STRATEGY = 'ssh';
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const SUPPORTED_STRATEGIES = Object.freeze(['ssh']);

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveBackupDir(aiHomeDir) {
  const root = nonEmptyString(aiHomeDir);
  if (!root) throw new Error('aiHomeDir is required');
  return path.join(root, BACKUP_DIR_NAME);
}

function resolveBackupConfigPath(aiHomeDir) {
  return path.join(resolveBackupDir(aiHomeDir), BACKUP_CONFIG_FILE);
}

function resolveBackupStatePath(aiHomeDir) {
  return path.join(resolveBackupDir(aiHomeDir), BACKUP_STATE_FILE);
}

function defaultBackupConfig() {
  return {
    version: BACKUP_CONFIG_VERSION,
    // 有目标就默认自动备份；用户可以用 `aih backup disable` 关掉。
    enabled: true,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    debounceSeconds: DEFAULT_DEBOUNCE_SECONDS,
    targets: []
  };
}

function slugify(value) {
  const text = nonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || 'target';
}

/**
 * 解析 user@host[:port]。IPv6 不在这里拆端口（含多个冒号时整段当主机名），
 * 需要端口就用 --port 显式给。
 */
function parseSshAddress(input) {
  let text = nonEmptyString(input);
  if (!text) throw new Error('缺少 SSH 目标（例如 ubuntu@1.2.3.4）');
  let username = '';
  const at = text.lastIndexOf('@');
  if (at > 0) {
    username = text.slice(0, at).trim();
    text = text.slice(at + 1).trim();
  }
  let port = 22;
  if ((text.match(/:/g) || []).length === 1) {
    const [hostPart, portPart] = text.split(':');
    if (/^\d+$/.test(portPart)) {
      port = Number(portPart);
      text = hostPart;
    }
  }
  if (!text) throw new Error('SSH 目标缺少主机名');
  if (!/^[A-Za-z0-9._:\[\]-]+$/.test(text)) throw new Error(`SSH 主机名不合法：${text}`);
  // IPv6 方括号只是地址写法，ssh2 要的是裸地址。
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (username && !/^[A-Za-z0-9._-]+$/.test(username)) throw new Error(`SSH 用户名不合法：${username}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SSH 端口不合法：${port}`);
  return { host: text, port, username };
}

function normalizeStrategy(value) {
  const strategy = nonEmptyString(value || DEFAULT_STRATEGY).toLowerCase();
  if (!SUPPORTED_STRATEGIES.includes(strategy)) {
    throw new Error(`不支持的备份策略：${strategy}（可用：${SUPPORTED_STRATEGIES.join(', ')}）`);
  }
  return strategy;
}

function normalizeRemoteDir(value) {
  const remoteDir = nonEmptyString(value || DEFAULT_REMOTE_DIR).replace(/\\/g, '/');
  if (!remoteDir) throw new Error('远程目录不能为空');
  if (remoteDir.includes('\0')) throw new Error('远程目录不合法');
  const segments = remoteDir.split('/');
  if (segments.includes('..')) throw new Error('远程目录不能包含 ..');
  return remoteDir;
}

function normalizeTarget(input = {}) {
  const address = parseSshAddress(input.address || input.ssh || input.host || '');
  const host = address.host;
  const username = nonEmptyString(input.username || address.username);
  if (!username) throw new Error('SSH 用户名不能为空（用 user@host 或 --user）');
  const port = Number(input.port || address.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SSH 端口不合法：${input.port}`);
  const strategy = normalizeStrategy(input.strategy);
  const id = nonEmptyString(input.id || input.name) || slugify(`${username}-${host}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`备份目标名不合法：${id}`);
  const target = {
    id,
    strategy,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    host,
    port,
    username,
    remoteDir: normalizeRemoteDir(input.remoteDir),
    identityFile: nonEmptyString(input.identityFile || input.key),
    passwordEnv: nonEmptyString(input.passwordEnv),
    hostKeyFingerprint: nonEmptyString(input.hostKeyFingerprint).toLowerCase()
  };
  if (target.passwordEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.passwordEnv)) {
    throw new Error(`密码环境变量名不合法：${target.passwordEnv}`);
  }
  if (target.hostKeyFingerprint && !/^[a-f0-9]{64}$/.test(target.hostKeyFingerprint)) {
    throw new Error('hostKeyFingerprint 必须是 sha256 的 64 位十六进制');
  }
  return target;
}

function normalizeConfig(raw, options = {}) {
  const strict = Boolean(options.strict);
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = defaultBackupConfig();
  config.enabled = source.enabled === undefined ? config.enabled : Boolean(source.enabled);
  const interval = Number(source.intervalMinutes);
  if (Number.isFinite(interval)) {
    config.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(interval)));
  }
  const debounce = Number(source.debounceSeconds);
  if (Number.isFinite(debounce)) {
    config.debounceSeconds = Math.max(0, Math.min(3600, Math.round(debounce)));
  }
  const targets = Array.isArray(source.targets) ? source.targets : [];
  const seen = new Set();
  for (const item of targets) {
    try {
      const target = normalizeTarget(item);
      if (seen.has(target.id)) {
        if (strict) throw new Error(`备份目标重复：${target.id}`);
        continue;
      }
      seen.add(target.id);
      config.targets.push(target);
    } catch (error) {
      if (strict) throw error;
      // 手改坏的一条目标不该让整个 server 起不来：跳过它，其余照常。
    }
  }
  return config;
}

function readBackupConfig(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = nonEmptyString(options.aiHomeDir);
  const file = resolveBackupConfigPath(aiHomeDir);
  if (!fs.existsSync(file)) return defaultBackupConfig();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`备份配置不是合法 JSON：${file}`);
  }
  return normalizeConfig(raw);
}

function writePrivateFile(fs, file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch (_error) { /* Windows 上可能不支持 */ }
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_error) { /* Windows 上可能不支持 */ }
}

function writeBackupConfig(options = {}) {
  const fs = options.fs || require('node:fs');
  const config = normalizeConfig(options.config, { strict: true });
  writePrivateFile(fs, resolveBackupConfigPath(options.aiHomeDir), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function findTargetIndex(config, selector) {
  const value = nonEmptyString(selector).toLowerCase();
  if (!value) return -1;
  return config.targets.findIndex((target) => {
    if (target.id.toLowerCase() === value) return true;
    return `${target.username}@${target.host}`.toLowerCase() === value;
  });
}

function addBackupTarget(options = {}) {
  const config = readBackupConfig(options);
  const target = normalizeTarget(options.target);
  if (config.targets.some((item) => item.id === target.id)) {
    throw new Error(`备份目标已存在：${target.id}（换个 --name 或先 remove）`);
  }
  config.targets.push(target);
  writeBackupConfig({ ...options, config });
  return { config, target };
}

function removeBackupTarget(options = {}) {
  const config = readBackupConfig(options);
  const index = findTargetIndex(config, options.selector);
  if (index < 0) throw new Error(`找不到备份目标：${nonEmptyString(options.selector)}`);
  const [removed] = config.targets.splice(index, 1);
  writeBackupConfig({ ...options, config });
  return { config, target: removed };
}

function setBackupTargetEnabled(options = {}) {
  const config = readBackupConfig(options);
  const index = findTargetIndex(config, options.selector);
  if (index < 0) throw new Error(`找不到备份目标：${nonEmptyString(options.selector)}`);
  config.targets[index] = { ...config.targets[index], enabled: Boolean(options.enabled) };
  writeBackupConfig({ ...options, config });
  return { config, target: config.targets[index] };
}

function updateBackupSettings(options = {}) {
  const config = readBackupConfig(options);
  if (options.enabled !== undefined) config.enabled = Boolean(options.enabled);
  if (options.intervalMinutes !== undefined) {
    const interval = Number(options.intervalMinutes);
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES) {
      throw new Error(`备份间隔必须是不小于 ${MIN_INTERVAL_MINUTES} 的分钟数`);
    }
    config.intervalMinutes = Math.min(MAX_INTERVAL_MINUTES, Math.round(interval));
  }
  if (options.debounceSeconds !== undefined) {
    const debounce = Number(options.debounceSeconds);
    if (!Number.isFinite(debounce) || debounce < 0) throw new Error('debounceSeconds 必须是非负数');
    config.debounceSeconds = Math.min(3600, Math.round(debounce));
  }
  writeBackupConfig({ ...options, config });
  return config;
}

function defaultBackupState() {
  return { version: BACKUP_STATE_VERSION, targets: {} };
}

function readBackupState(options = {}) {
  const fs = options.fs || require('node:fs');
  const file = resolveBackupStatePath(options.aiHomeDir);
  if (!fs.existsSync(file)) return defaultBackupState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: BACKUP_STATE_VERSION,
      targets: raw && typeof raw.targets === 'object' && raw.targets ? raw.targets : {}
    };
  } catch (_error) {
    return defaultBackupState();
  }
}

function writeBackupState(options = {}) {
  const fs = options.fs || require('node:fs');
  const state = {
    version: BACKUP_STATE_VERSION,
    targets: options.state && options.state.targets && typeof options.state.targets === 'object'
      ? options.state.targets
      : {}
  };
  writePrivateFile(fs, resolveBackupStatePath(options.aiHomeDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

module.exports = {
  BACKUP_CONFIG_FILE,
  BACKUP_CONFIG_VERSION,
  BACKUP_DIR_NAME,
  BACKUP_STATE_FILE,
  BACKUP_STATE_VERSION,
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_REMOTE_DIR,
  DEFAULT_STRATEGY,
  SUPPORTED_STRATEGIES,
  addBackupTarget,
  defaultBackupConfig,
  defaultBackupState,
  findTargetIndex,
  normalizeConfig,
  normalizeTarget,
  parseSshAddress,
  readBackupConfig,
  readBackupState,
  removeBackupTarget,
  resolveBackupConfigPath,
  resolveBackupDir,
  resolveBackupStatePath,
  setBackupTargetEnabled,
  updateBackupSettings,
  writeBackupConfig,
  writeBackupState
};
