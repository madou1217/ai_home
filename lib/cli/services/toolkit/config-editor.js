'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { listProviderDefinitions } = require('../../../provider-catalog');
const { CLIENT_PLATFORMS, resolveClientPlatform } = require('../../../runtime/client-platform');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const {
  getProviderConfigPath,
  getConfigFormat,
  resolveHostHome
} = require('./app-manager');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

// Provider 配置入口来自统一合同；这里仅保留宿主客户端和工具的特殊别名。
// 新 Provider 只要声明了合同，就能被配置编辑器识别，不需要再修改此文件。
function buildConfigAppAliases() {
  const aliases = {};
  listProviderDefinitions().forEach((definition) => {
    const provider = String(definition && definition.id || '').trim().toLowerCase();
    if (!provider) return;
    aliases[provider] = provider;
    if (definition.clients && definition.clients.desktop) {
      aliases[`${provider}-desktop`] = provider === 'claude' ? 'claude-desktop' : provider;
    }
  });
  aliases.claude = aliases.claude || 'claude';
  aliases.vscode = 'vscode';
  return Object.freeze(aliases);
}

const CONFIG_APP_ALIASES = buildConfigAppAliases();
const CONFIG_TOOL_ALIASES = Object.freeze({
  frpc: 'frpc'
});
const ELEVATION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

class ToolkitConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolkitConfigError';
    this.code = code;
    Object.assign(this, details);
  }
}

function normalizeAppId(value) {
  return String(value || '').trim().toLowerCase();
}

function resolvePlatform(options = {}) {
  return resolveClientPlatform(options);
}

function resolvePathApi(options = {}, platform = resolvePlatform(options)) {
  return resolvePlatformPath(platform, options.path || nodePath);
}

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function resolveTarget(appId, options = {}) {
  const normalizedAppId = normalizeAppId(appId);
  const provider = CONFIG_APP_ALIASES[normalizedAppId]
    || (String(options.targetPath || '').trim() ? CONFIG_TOOL_ALIASES[normalizedAppId] : '');
  if (!provider) {
    throw new ToolkitConfigError('unsupported_app', `不支持编辑应用 ${normalizedAppId || 'unknown'}`);
  }

  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options, platform);
  const hostHomeDir = resolveHostHome(options);
  const targetPath = String(options.targetPath || '').trim()
    || getProviderConfigPath(provider, hostHomeDir, pathImpl, {
      ...options,
      platform,
      env: resolveEnv(options)
    });
  if (!targetPath) {
    throw new ToolkitConfigError('config_target_unavailable', '当前平台没有可解析的配置目标');
  }

  return {
    appId: normalizedAppId,
    provider,
    platform,
    pathImpl,
    hostHomeDir,
    targetPath,
    configName: pathImpl.basename(targetPath),
    configFormat: getConfigFormat(targetPath)
  };
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function isElevationError(error) {
  return Boolean(error && ELEVATION_ERROR_CODES.has(String(error.code || '').trim()));
}

function configIoError(operation, error) {
  const code = String(error && error.code || '').trim();
  if (code === 'ENOENT') {
    return new ToolkitConfigError(
      'config_target_changed',
      '配置目标在操作期间发生变化，请重新读取后再试'
    );
  }
  return new ToolkitConfigError(
    operation === 'read' ? 'config_read_failed' : 'config_save_failed',
    operation === 'read' ? '读取配置失败' : '保存配置失败'
  );
}

function configNotFoundError() {
  return new ToolkitConfigError(
    'config_not_found',
    '配置文件不存在，只能编辑已存在的配置'
  );
}

function canAccess(fsImpl, targetPath, mode) {
  try {
    fsImpl.accessSync(targetPath, mode);
    return true;
  } catch (_error) {
    return false;
  }
}

function isWritableTarget(fsImpl, pathImpl, targetPath) {
  if (fsImpl.existsSync(targetPath)) return canAccess(fsImpl, targetPath, nodeFs.constants.W_OK);
  let directory = pathImpl.dirname(targetPath);
  while (directory) {
    if (fsImpl.existsSync(directory)) return canAccess(fsImpl, directory, nodeFs.constants.W_OK);
    const parent = pathImpl.dirname(directory);
    if (!parent || parent === directory) return false;
    directory = parent;
  }
  return false;
}

function removeTempTree(fsImpl, pathImpl, tempDir) {
  if (!tempDir) return;
  try {
    if (typeof fsImpl.rmSync === 'function') {
      fsImpl.rmSync(tempDir, { recursive: true, force: true });
      return;
    }
    const names = fsImpl.readdirSync(tempDir);
    names.forEach((name) => {
      try { fsImpl.unlinkSync(pathImpl.join(tempDir, name)); } catch (_error) {}
    });
    try { fsImpl.rmdirSync(tempDir); } catch (_error) {}
  } catch (_error) {}
}

function createTempPayload(fsImpl, pathImpl, osImpl, content = '') {
  const tempRoot = String(osImpl.tmpdir ? osImpl.tmpdir() : nodeOs.tmpdir());
  const tempDir = fsImpl.mkdtempSync(pathImpl.join(tempRoot, 'aih-toolkit-config-'));
  const tempPath = pathImpl.join(tempDir, 'payload');
  fsImpl.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  if (typeof fsImpl.chmodSync === 'function') {
    try { fsImpl.chmodSync(tempPath, 0o600); } catch (_error) {}
  }
  return { tempDir, tempPath };
}

function quoteShellArg(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function quoteAppleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') }"`;
}

function encodePowerShell(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function createSiblingTempPath(targetPath) {
  return `${targetPath}.aih-edit-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

function buildUnixCopyCommand(sourcePath, targetPath, stagingPath, mode) {
  const parentPath = nodePath.dirname(targetPath);
  const normalizedMode = /^[0-7]{3,4}$/.test(String(mode || '')) ? String(mode) : '600';
  const operation = [
    `/bin/mkdir -p -- ${quoteShellArg(parentPath)}`,
    `/usr/bin/install -m ${normalizedMode} -- ${quoteShellArg(sourcePath)} ${quoteShellArg(stagingPath)}`,
    `/bin/mv -f -- ${quoteShellArg(stagingPath)} ${quoteShellArg(targetPath)}`
  ].join(' && ');
  return `${operation}; aih_config_status=$?; /bin/rm -f -- ${quoteShellArg(stagingPath)}; exit $aih_config_status`;
}

function buildUnixReadCommand(sourcePath, targetPath) {
  return `/bin/cat -- ${quoteShellArg(sourcePath)} > ${quoteShellArg(targetPath)}`;
}

function runWindowsElevated(script, options = {}) {
  const spawnSyncImpl = options.spawnSync || systemSpawnSync;
  const processObj = options.processObj || process;
  const innerEncoded = encodePowerShell(script);
  const outerScript = [
    "$ErrorActionPreference = 'Stop'",
    `$innerEncoded = ${quotePowerShellLiteral(innerEncoded)}`,
    `$elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $innerEncoded) -Verb RunAs -Wait -PassThru`,
    'exit $elevated.ExitCode'
  ].join('; ');
  const result = spawnSyncImpl('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShell(outerScript)
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: processObj.env
  });
  return {
    ok: Boolean(result && result.status === 0),
    available: !(result && result.error && result.error.code === 'ENOENT'),
    cancelled: Boolean(result && result.status !== 0),
    detail: String(result && (result.stderr || result.stdout) || '').trim(),
    error: result && result.error
  };
}

function runUnixElevated(command, platform, options = {}) {
  const spawnSyncImpl = options.spawnSync || systemSpawnSync;
  const processObj = options.processObj || process;
  if (platform === CLIENT_PLATFORMS.MACOS) {
    const result = spawnSyncImpl('osascript', [
      '-e',
      `do shell script ${quoteAppleScriptString(command)} with administrator privileges`
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: processObj.env
    });
    return {
      ok: Boolean(result && result.status === 0),
      available: !(result && result.error && result.error.code === 'ENOENT'),
      cancelled: Boolean(result && result.status !== 0),
      detail: String(result && (result.stderr || result.stdout) || '').trim(),
      error: result && result.error
    };
  }

  const result = spawnSyncImpl('pkexec', ['/bin/sh', '-c', command], {
    encoding: 'utf8',
    windowsHide: true,
    env: processObj.env
  });
  if (result && result.status === 0) {
    return { ok: true, available: true, cancelled: false, detail: '' };
  }
  if (!(result && result.error && result.error.code === 'ENOENT')) {
    return {
      ok: false,
      available: true,
      cancelled: true,
      detail: String(result && (result.stderr || result.stdout) || '').trim(),
      error: result && result.error
    };
  }

  const fallback = spawnSyncImpl('sudo', ['-n', '/bin/sh', '-c', command], {
    encoding: 'utf8',
    windowsHide: true,
    env: processObj.env
  });
  return {
    ok: Boolean(fallback && fallback.status === 0),
    available: !(fallback && fallback.error && fallback.error.code === 'ENOENT'),
    cancelled: Boolean(fallback && fallback.status !== 0),
    detail: String(fallback && (fallback.stderr || fallback.stdout) || '').trim(),
    error: fallback && fallback.error
  };
}

function runElevatedCopy(sourcePath, targetPath, mode, options = {}) {
  const platform = resolvePlatform(options);
  const stagingPath = createSiblingTempPath(targetPath);
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const pathLiteral = quotePowerShellLiteral;
    return runWindowsElevated([
      "$ErrorActionPreference = 'Stop'",
      `$parent = Split-Path -Parent -LiteralPath ${pathLiteral(targetPath)}`,
      'New-Item -ItemType Directory -Force -Path $parent | Out-Null',
      `try { Copy-Item -LiteralPath ${pathLiteral(sourcePath)} -Destination ${pathLiteral(stagingPath)} -Force; if (Test-Path -LiteralPath ${pathLiteral(targetPath)}) { [IO.File]::Replace(${pathLiteral(stagingPath)}, ${pathLiteral(targetPath)}, $null, $true) } else { [IO.File]::Move(${pathLiteral(stagingPath)}, ${pathLiteral(targetPath)}) } } finally { if (Test-Path -LiteralPath ${pathLiteral(stagingPath)}) { Remove-Item -LiteralPath ${pathLiteral(stagingPath)} -Force } }`
    ].join('; '), options);
  }
  return runUnixElevated(buildUnixCopyCommand(sourcePath, targetPath, stagingPath, mode), platform, options);
}

function runElevatedRead(sourcePath, targetPath, options = {}) {
  const platform = resolvePlatform(options);
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const pathLiteral = quotePowerShellLiteral;
    return runWindowsElevated([
      "$ErrorActionPreference = 'Stop'",
      `[IO.File]::WriteAllText(${pathLiteral(targetPath)}, [IO.File]::ReadAllText(${pathLiteral(sourcePath)}), [Text.UTF8Encoding]::new($false))`
    ].join('; '), options);
  }
  return runUnixElevated(buildUnixReadCommand(sourcePath, targetPath), platform, options);
}

function buildElevationError(operation, result) {
  if (!result || !result.available) {
    return new ToolkitConfigError(
      'privilege_unavailable',
      `${operation}配置需要系统授权，但当前平台没有可用的授权工具`
    );
  }
  return new ToolkitConfigError(
    'privilege_denied',
    `${operation}配置的系统授权未完成`,
    { detail: result.detail || '' }
  );
}

function readTextFile(fsImpl, targetPath) {
  return String(fsImpl.readFileSync(targetPath, 'utf8') || '');
}

function readElevatedTextFile(target, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = target.pathImpl;
  const osImpl = options.os || nodeOs;
  const temp = createTempPayload(fsImpl, pathImpl, osImpl);
  try {
    const result = runElevatedRead(target.targetPath, temp.tempPath, options);
    if (!result.ok) throw buildElevationError('读取', result);
    return readTextFile(fsImpl, temp.tempPath);
  } finally {
    removeTempTree(fsImpl, pathImpl, temp.tempDir);
  }
}

function canonicalizeExistingTarget(target, fsImpl) {
  try {
    if (fsImpl.existsSync(target.targetPath) && typeof fsImpl.realpathSync === 'function') {
      return { ...target, targetPath: fsImpl.realpathSync(target.targetPath) };
    }
  } catch (_error) {}
  return target;
}

function resolveFileMode(fsImpl, targetPath) {
  try {
    const stat = fsImpl.statSync(targetPath);
    if (stat && Number.isFinite(stat.mode)) return stat.mode & 0o777;
  } catch (_error) {}
  return 0o600;
}

function writeAtomicFile(fsImpl, pathImpl, targetPath, content) {
  const parentPath = pathImpl.dirname(targetPath);
  fsImpl.mkdirSync(parentPath, { recursive: true });
  const mode = resolveFileMode(fsImpl, targetPath);

  const tempPath = createSiblingTempPath(targetPath);
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    if (typeof fsImpl.chmodSync === 'function') {
      try { fsImpl.chmodSync(tempPath, mode); } catch (_error) {}
    }
    if (!fsImpl.existsSync(targetPath)) throw configNotFoundError();
    fsImpl.renameSync(tempPath, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tempPath); } catch (_error) {}
    }
  }
  return mode;
}

function readManagedAppConfig(appId, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const displayTarget = resolveTarget(appId, options);
  const target = canonicalizeExistingTarget(displayTarget, fsImpl);
  const exists = fsImpl.existsSync(target.targetPath);
  const writable = isWritableTarget(fsImpl, target.pathImpl, target.targetPath);
  if (!exists) {
    throw configNotFoundError();
  }

  let elevated = false;
  let content;
  try {
    content = readTextFile(fsImpl, target.targetPath);
  } catch (error) {
    if (isElevationError(error)) {
      content = readElevatedTextFile(target, options);
      elevated = true;
    } else {
      throw configIoError('read', error);
    }
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ToolkitConfigError('config_too_large', '配置文件超过 2MB 编辑上限');
  }
  return {
    ok: true,
    appId: displayTarget.appId,
    configName: displayTarget.configName,
    configFormat: displayTarget.configFormat,
    exists: true,
    content,
    revision: hashContent(content),
    writable,
    requiresElevation: !writable,
    elevated
  };
}

function saveManagedAppConfig(appId, content, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const displayTarget = resolveTarget(appId, options);
  const target = canonicalizeExistingTarget(displayTarget, fsImpl);
  if (!fsImpl.existsSync(target.targetPath)) throw configNotFoundError();
  const value = String(content == null ? '' : content);
  if (Buffer.byteLength(value, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ToolkitConfigError('config_too_large', '配置文件超过 2MB 编辑上限');
  }

  const expectedRevision = String(options.expectedRevision || '').trim();
  if (expectedRevision) {
    const current = readManagedAppConfig(appId, options);
    if (current.revision !== expectedRevision) {
      throw new ToolkitConfigError(
        'config_conflict',
        '配置文件在编辑期间已被其他进程修改，请重新读取后再保存'
      );
    }
  }

  let elevated = false;
  try {
    writeAtomicFile(fsImpl, target.pathImpl, target.targetPath, value);
  } catch (error) {
    if (error instanceof ToolkitConfigError) throw error;
    if (!isElevationError(error)) throw configIoError('save', error);
    const osImpl = options.os || nodeOs;
    const temp = createTempPayload(fsImpl, target.pathImpl, osImpl, value);
    try {
      const mode = resolveFileMode(fsImpl, target.targetPath).toString(8);
      const result = runElevatedCopy(temp.tempPath, target.targetPath, mode, options);
      if (!result.ok) throw buildElevationError('保存', result);
      elevated = true;
    } finally {
      removeTempTree(fsImpl, target.pathImpl, temp.tempDir);
    }
  }

  return {
    ok: true,
    appId: displayTarget.appId,
    configName: displayTarget.configName,
    configFormat: displayTarget.configFormat,
    exists: true,
    revision: hashContent(value),
    size: Buffer.byteLength(value, 'utf8'),
    elevated,
    requiresElevation: elevated
  };
}

module.exports = {
  CONFIG_APP_ALIASES,
  MAX_CONFIG_BYTES,
  ToolkitConfigError,
  getConfigFormat,
  readManagedAppConfig,
  resolveTarget,
  saveManagedAppConfig
};
