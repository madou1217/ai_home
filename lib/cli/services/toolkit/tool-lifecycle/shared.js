'use strict';

const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../../runtime/command-path');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const {
  normalizeClientPlatform,
  toNodePlatform
} = require('../../../../runtime/client-platform');

const TOOL_LIFECYCLE_ACTIONS = new Set(['install', 'update', 'uninstall']);

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return toNodePlatform(
    normalizeClientPlatform(options.platform || processObj.platform || process.platform)
  );
}

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function resolvePathApi(options = {}) {
  return resolvePlatformPath(resolvePlatform(options), options.path || nodePath);
}

function resolveHostHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  const env = resolveEnv(options);
  if (resolvePlatform(options) === 'win32') {
    return String(env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH
      ? `${env.HOMEDRIVE}${env.HOMEPATH}`
      : '') || env.HOME || '').trim();
  }
  return String(env.HOME || '').trim();
}

function resolveManagedFrpcPath(options = {}) {
  const platform = resolvePlatform(options);
  const env = resolveEnv(options);
  const pathImpl = resolvePathApi(options);
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || env.LocalAppData || '').trim()
      || (resolveHostHome(options) ? pathImpl.join(resolveHostHome(options), 'AppData', 'Local') : '');
    return localAppData ? pathImpl.join(localAppData, 'AIHome', 'bin', 'frpc.exe') : '';
  }
  const home = resolveHostHome(options);
  return home ? pathImpl.join(home, '.local', 'bin', 'frpc') : '';
}

function normalizeArch(options = {}) {
  const processObj = options.processObj || process;
  const arch = String(options.arch || processObj.arch || process.arch).trim().toLowerCase();
  if (arch === 'x64' || arch === 'amd64') return 'amd64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return '';
}

function resolveCommand(command, options = {}) {
  const platform = resolvePlatform(options);
  const env = resolveEnv(options);
  const resolvePath = options.resolveCommandPath || ((name) => defaultResolveCommandPath(name, {
    platform,
    env,
    spawnSyncImpl: options.spawnSync || systemSpawnSync
  }));
  try {
    return String(resolvePath(command, { platform, env }) || '').trim();
  } catch (_error) {
    return '';
  }
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return TOOL_LIFECYCLE_ACTIONS.has(action) ? action : '';
}

function quotePreviewToken(value, platform) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,\\-]+$/.test(text)) return text;
  if (platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function renderPlanCommand(plan, platform) {
  return [plan.command, ...(plan.args || [])]
    .map((part) => quotePreviewToken(part, platform))
    .join(' ');
}

function createPlan(toolId, action, command, args = [], options = {}) {
  const platform = resolvePlatform(options.runtimeOptions || options);
  const plan = {
    id: String(options.id || `${toolId}_${action}`).trim(),
    toolId: String(toolId || '').trim().toLowerCase(),
    action: normalizeAction(action),
    label: String(options.label || '').trim(),
    method: String(options.method || '').trim(),
    command: String(command || '').trim(),
    args: Array.isArray(args) ? args.map((arg) => String(arg)) : [],
    env: options.env && typeof options.env === 'object' ? { ...options.env } : {},
    cwd: String(options.cwd || '').trim() || null,
    effect: String(options.effect || '').trim(),
    timeoutMs: Math.min(Math.max(Number(options.timeoutMs) || 10 * 60 * 1000, 1000), 60 * 60 * 1000),
    requiresConfirmation: true
  };
  return { ...plan, preview: renderPlanCommand(plan, platform) };
}

function resolveReleaseRunnerPath(options = {}) {
  return nodePath.join(__dirname, 'frpc-release-runner.js');
}

function buildOfficialReleasePlan(action, options = {}) {
  const platform = resolvePlatform(options);
  const processObj = options.processObj || process;
  const actionLabel = { install: '安装', update: '更新', uninstall: '卸载' }[action] || action;
  const planEnv = {
    ...(resolveHostHome(options) ? { AIH_HOST_HOME: resolveHostHome(options) } : {})
  };
  return createPlan('frpc', action, processObj.execPath || process.execPath, [
    resolveReleaseRunnerPath(options),
    action
  ], {
    id: `frpc_${action}_official_release`,
    label: `${actionLabel} frpc`,
    method: action === 'uninstall' ? 'AIH 受管文件清理' : 'frp 官方发布包 + SHA256',
    effect: action === 'uninstall'
      ? '仅移除 AIH 管理的 frpc 可执行文件'
      : `${actionLabel} frpc 到用户级可执行目录`,
    env: planEnv,
    runtimeOptions: options
  });
}

function normalizeExternalFrpcPath(executablePath, options = {}) {
  const pathImpl = resolvePathApi(options);
  const candidate = String(executablePath || '').trim();
  if (!candidate || !pathImpl.isAbsolute(candidate)) return '';
  const normalized = pathImpl.normalize(candidate);
  const expectedName = resolvePlatform(options) === 'win32' ? 'frpc.exe' : 'frpc';
  if (pathImpl.basename(normalized).toLowerCase() !== expectedName) return '';
  return normalized;
}

function buildExternalRemovalPlan(executablePath, options = {}) {
  const targetPath = normalizeExternalFrpcPath(executablePath, options);
  if (!targetPath) return null;
  const processObj = options.processObj || process;
  return createPlan('frpc', 'uninstall', processObj.execPath || process.execPath, [
    resolveReleaseRunnerPath(options),
    'uninstall',
    '--target',
    targetPath
  ], {
    id: 'frpc_uninstall_external_path',
    label: '卸载外部 frpc',
    method: '精确路径清理',
    effect: `移除当前探测到的 frpc 可执行文件：${targetPath}`,
    runtimeOptions: options
  });
}

function buildHomebrewPlan(action, brewPath, options = {}) {
  const actionArgs = {
    install: ['install', 'frpc'],
    update: ['upgrade', 'frpc'],
    uninstall: ['uninstall', 'frpc']
  }[action] || [];
  const actionLabel = { install: '安装', update: '更新', uninstall: '卸载' }[action] || action;
  return createPlan('frpc', action, brewPath || 'brew', actionArgs, {
    id: `frpc_${action}_homebrew`,
    label: `Homebrew ${actionLabel} frpc`,
    method: 'Homebrew',
    effect: `${actionLabel} Homebrew 管理的 frpc`,
    runtimeOptions: options
  });
}

function samePath(left, right, options = {}) {
  if (!left || !right) return false;
  const pathImpl = resolvePathApi(options);
  const normalize = (value) => pathImpl.normalize(String(value));
  return resolvePlatform(options) === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function isHomebrewFrpc(executablePath, options = {}) {
  if (resolvePlatform(options) !== 'darwin') return false;
  const normalized = String(executablePath || '').replace(/\\/g, '/');
  if (/\/(?:homebrew|linuxbrew)\/(?:bin|Cellar)\/frpc(?:\/|$)/i.test(normalized)
    || /^\/opt\/homebrew\/(?:bin|Cellar)\/frpc(?:\/|$)/i.test(normalized)
    || /^\/usr\/local\/(?:bin|Cellar)\/frpc(?:\/|$)/i.test(normalized)) return true;
  const brewPath = resolveCommand('brew', options);
  if (!brewPath) return false;
  try {
    const result = (options.spawnSync || systemSpawnSync)(brewPath, ['list', '--formula', 'frpc'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    return Boolean(result && result.status === 0);
  } catch (_error) {
    return false;
  }
}

function inspectFrpcOwnership(executablePath, options = {}) {
  const managed = samePath(executablePath, resolveManagedFrpcPath(options), options);
  const homebrew = !managed && isHomebrewFrpc(executablePath, options);
  return {
    executablePath: String(executablePath || ''),
    managed,
    homebrew,
    external: !managed && !homebrew && Boolean(normalizeExternalFrpcPath(executablePath, options))
  };
}

module.exports = {
  TOOL_LIFECYCLE_ACTIONS,
  buildExternalRemovalPlan,
  buildHomebrewPlan,
  buildOfficialReleasePlan,
  createPlan,
  inspectFrpcOwnership,
  normalizeExternalFrpcPath,
  normalizeAction,
  normalizeArch,
  renderPlanCommand,
  resolveCommand,
  resolveEnv,
  resolveHostHome,
  resolveManagedFrpcPath,
  resolvePlatform,
  samePath
};
