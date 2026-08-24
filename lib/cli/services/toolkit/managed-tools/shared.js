'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../../runtime/command-path');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const {
  normalizeClientPlatform,
  toNodePlatform
} = require('../../../../runtime/client-platform');

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return toNodePlatform(normalizeClientPlatform(
    options.platform || processObj.platform || process.platform
  ));
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

function resolveAiHomeDir(options = {}) {
  const env = resolveEnv(options);
  const pathImpl = resolvePathApi(options);
  const home = resolveHostHome(options);
  return String(options.aiHomeDir || env.AIH_HOME || env.AI_HOME
    || (home ? pathImpl.join(home, '.ai_home') : '')).trim();
}

function resolveTmuxUserConfigPath(options = {}) {
  const aiHomeDir = resolveAiHomeDir(options);
  return aiHomeDir ? resolvePathApi(options).join(aiHomeDir, 'config', 'tmux.conf') : '';
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

function pathExists(targetPath, options = {}) {
  if (!targetPath) return false;
  const fsImpl = options.fs || nodeFs;
  try {
    if (fsImpl.existsSync(targetPath)) return true;
  } catch (_error) {}
  try {
    fsImpl.accessSync(targetPath);
    return true;
  } catch (_error) {}
  try {
    return Boolean(fsImpl.lstatSync(targetPath));
  } catch (_error) {
    return false;
  }
}

function parseVersion(output) {
  const text = String(output || '').trim();
  const match = text.match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?=$|[^0-9A-Za-z])/i);
  return match ? match[1] : '';
}

function probeVersion(executablePath, versionArgs, options = {}) {
  if (!executablePath) return '';
  const spawnSync = options.spawnSync || systemSpawnSync;
  for (const args of versionArgs || [['--version']]) {
    try {
      const result = spawnSync(executablePath, args, {
        encoding: 'utf8', timeout: 3000, windowsHide: true
      });
      if (!result || result.status !== 0) continue;
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      const parsed = parseVersion(output);
      if (parsed) return parsed;
      const firstLine = output.trim().split(/\r?\n/)[0];
      if (firstLine) return firstLine.slice(0, 64);
    } catch (_error) {}
  }
  return '';
}

function samePath(left, right, options = {}) {
  if (!left || !right) return false;
  const pathImpl = resolvePathApi(options);
  const normalize = (value) => pathImpl.normalize(String(value));
  return resolvePlatform(options) === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function isHomebrewFormula(formula, executablePath, options = {}) {
  if (resolvePlatform(options) !== 'darwin') return false;
  const normalized = String(executablePath || '').replace(/\\/g, '/');
  if (new RegExp(`/(?:homebrew|linuxbrew)/(?:bin|Cellar)/${formula}(?:/|$)`, 'i').test(normalized)
    || new RegExp(`^/opt/homebrew/(?:bin|Cellar)/${formula}(?:/|$)`, 'i').test(normalized)
    || new RegExp(`^/usr/local/(?:bin|Cellar)/${formula}(?:/|$)`, 'i').test(normalized)) return true;
  const brew = resolveCommand('brew', options);
  if (!brew) return false;
  try {
    const result = (options.spawnSync || systemSpawnSync)(brew, ['list', '--formula', formula], {
      encoding: 'utf8', timeout: 3000, windowsHide: true
    });
    return Boolean(result && result.status === 0);
  } catch (_error) {
    return false;
  }
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
    action: String(action || '').trim().toLowerCase(),
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

function actionLabel(action) {
  return ({ install: '安装', update: '更新', uninstall: '卸载' })[action] || action;
}

function serviceManagerFor(options = {}) {
  const platform = resolvePlatform(options);
  if (platform === 'win32') return 'windows-service';
  if (platform === 'darwin') return 'launchd-or-homebrew';
  if (platform === 'linux') return 'systemd';
  return 'unknown';
}

function emptyConfigPresentation() {
  return {
    configName: '',
    configFormat: '',
    configExists: false,
    configWritable: false,
    requiresElevation: false,
    configEditable: false,
    configCount: 0,
    configAmbiguous: false,
    configState: 'none',
    configSource: ''
  };
}

function canAccess(fsImpl, targetPath, mode) {
  try {
    fsImpl.accessSync(targetPath, mode);
    return true;
  } catch (_error) {
    return false;
  }
}

function writableTarget(targetPath, options = {}) {
  if (!targetPath) return false;
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  if (pathExists(targetPath, options)) {
    return canAccess(fsImpl, targetPath, nodeFs.constants.W_OK);
  }
  let directory = pathImpl.dirname(targetPath);
  while (directory) {
    if (pathExists(directory, options)) {
      return canAccess(fsImpl, directory, nodeFs.constants.W_OK);
    }
    const parent = pathImpl.dirname(directory);
    if (!parent || parent === directory) return false;
    directory = parent;
  }
  return false;
}

function inspectConfigTarget(target = {}, options = {}) {
  const targetPath = String(target.targetPath || '').trim();
  if (!targetPath) return emptyConfigPresentation();
  const pathImpl = resolvePathApi(options);
  const exists = pathExists(targetPath, options);
  const writable = writableTarget(targetPath, options);
  const ambiguous = Boolean(target.ambiguous);
  const state = String(target.state || (exists ? 'single' : 'none'));
  const editable = !ambiguous && state !== 'unresolved'
    && (exists || Boolean(target.allowMissing));
  return {
    configName: String(target.name || (exists || target.allowMissing ? pathImpl.basename(targetPath) : '')),
    configFormat: String(target.format || ''),
    configExists: exists,
    configWritable: writable,
    requiresElevation: Boolean(editable && !writable),
    configEditable: editable,
    configCount: Number(target.count || (exists ? 1 : 0)),
    configAmbiguous: ambiguous,
    configState: state,
    configSource: String(target.source || '')
  };
}

function resolveLinuxPackageManager(options = {}) {
  if (resolvePlatform(options) !== 'linux') return null;
  const definitions = [
    { id: 'apt', command: 'apt-get', install: ['install', '-y'], update: ['install', '--only-upgrade', '-y'], uninstall: ['remove', '-y'] },
    { id: 'dnf', command: 'dnf', install: ['install', '-y'], update: ['upgrade', '-y'], uninstall: ['remove', '-y'] },
    { id: 'yum', command: 'yum', install: ['install', '-y'], update: ['update', '-y'], uninstall: ['remove', '-y'] },
    { id: 'pacman', command: 'pacman', install: ['-S', '--noconfirm'], update: ['-S', '--noconfirm'], uninstall: ['-R', '--noconfirm'] },
    { id: 'zypper', command: 'zypper', install: ['--non-interactive', 'install'], update: ['--non-interactive', 'update'], uninstall: ['--non-interactive', 'remove'] },
    { id: 'apk', command: 'apk', install: ['add'], update: ['upgrade'], uninstall: ['del'] }
  ];
  for (const definition of definitions) {
    const command = resolveCommand(definition.command, options);
    if (command) return { ...definition, command };
  }
  return null;
}

function withUnixElevation(command, args, options = {}) {
  const processObj = options.processObj || process;
  if (resolvePlatform(options) !== 'linux'
    || (typeof processObj.getuid === 'function' && processObj.getuid() === 0)) {
    return { command, args };
  }
  const sudo = resolveCommand('sudo', options);
  return sudo ? { command: sudo, args: [command, ...args] } : { command, args };
}

module.exports = {
  actionLabel,
  createPlan,
  isHomebrewFormula,
  parseVersion,
  pathExists,
  probeVersion,
  renderPlanCommand,
  emptyConfigPresentation,
  inspectConfigTarget,
  resolveLinuxPackageManager,
  resolveAiHomeDir,
  resolveCommand,
  resolveEnv,
  resolveHostHome,
  resolvePathApi,
  resolvePlatform,
  resolveTmuxUserConfigPath,
  serviceManagerFor,
  samePath,
  withUnixElevation
};
