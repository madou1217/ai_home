'use strict';

const { PSMUX_WINGET_PACKAGE_ID } = require('../../../../runtime/persistent-session');
const { defineManagedToolAdapter } = require('./adapter');
const {
  actionLabel,
  createPlan,
  emptyConfigPresentation,
  inspectConfigTarget,
  pathExists,
  probeVersion,
  resolveCommand,
  resolveEnv,
  resolvePathApi,
  resolvePlatform,
  resolveTmuxUserConfigPath,
  serviceManagerFor
} = require('./shared');

function supports(options = {}) {
  return resolvePlatform(options) === 'win32';
}

function resolvePsmuxPath(options = {}) {
  const command = resolveCommand('psmux', options);
  if (command) return command;
  const env = resolveEnv(options);
  const pathImpl = resolvePathApi(options);
  const home = String(options.hostHomeDir || env.USERPROFILE || '').trim();
  const localAppData = String(env.LOCALAPPDATA || env.LocalAppData || '').trim()
    || (home ? pathImpl.join(home, 'AppData', 'Local') : '');
  const candidates = [
    localAppData && pathImpl.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'psmux.exe'),
    home && pathImpl.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'psmux.exe')
  ].filter(Boolean);
  return candidates.find((candidate) => pathExists(candidate, options)) || '';
}

function resolveConfig(options = {}) {
  const targetPath = resolveTmuxUserConfigPath(options);
  return targetPath ? {
    targetPath,
    name: 'tmux.conf',
    format: 'conf',
    allowMissing: true,
    state: 'stable-user-override',
    source: 'aih-user-config'
  } : null;
}

function detect(options = {}) {
  const executablePath = resolvePsmuxPath(options);
  const installed = Boolean(executablePath);
  const winget = resolveCommand('winget', options);
  const config = resolveConfig(options);
  return {
    installed,
    executablePath,
    binaryName: 'psmux.exe',
    version: installed ? (probeVersion(executablePath, [['-V'], ['--version']], options) || '未探测到') : '-',
    managedBy: winget && installed ? 'winget' : '',
    canInstall: !installed && Boolean(winget),
    canUpdate: installed && Boolean(winget),
    canUninstall: installed && Boolean(winget),
    lifecycle: {
      install: !installed && Boolean(winget),
      update: installed && Boolean(winget),
      uninstall: installed && Boolean(winget)
    },
    serviceManager: serviceManagerFor(options),
    running: false,
    runningCount: 0,
    startupManaged: false,
    startupSources: [],
    ...(config ? inspectConfigTarget(config, options) : emptyConfigPresentation())
  };
}

function planAction(action, context = {}) {
  const options = context.options || {};
  const winget = resolveCommand('winget', options);
  if (!winget) return [];
  const argsByAction = {
    install: ['install', '--id', PSMUX_WINGET_PACKAGE_ID, '--exact', '--accept-package-agreements', '--accept-source-agreements'],
    update: ['upgrade', '--id', PSMUX_WINGET_PACKAGE_ID, '--exact', '--accept-package-agreements', '--accept-source-agreements'],
    uninstall: ['uninstall', '--id', PSMUX_WINGET_PACKAGE_ID, '--exact']
  };
  const args = argsByAction[action];
  if (!args) return [];
  return [createPlan('psmux', action, winget, args, {
    id: `psmux_${action}_winget`,
    label: `WinGet ${actionLabel(action)} psmux`,
    method: 'WinGet',
    effect: `${actionLabel(action)} WinGet 管理的 psmux`,
    runtimeOptions: options
  })];
}

module.exports = defineManagedToolAdapter({
  id: 'psmux',
  category: 'session-runtimes',
  name: 'psmux',
  role: 'Windows 原生 tmux 兼容运行时',
  binaryName: 'psmux.exe',
  versionArgs: [['-V'], ['--version']],
  capabilities: ['detect', 'version', 'sessions', 'config-edit'],
  supports,
  detect,
  resolveConfig,
  install: (context) => planAction('install', context),
  update: (context) => planAction('update', context),
  uninstall: (context) => planAction('uninstall', context)
});
