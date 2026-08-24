'use strict';

const { defineManagedToolAdapter } = require('./adapter');
const {
  actionLabel,
  createPlan,
  emptyConfigPresentation,
  inspectConfigTarget,
  isHomebrewFormula,
  probeVersion,
  resolveCommand,
  resolveLinuxPackageManager,
  resolvePlatform,
  resolveTmuxUserConfigPath,
  serviceManagerFor,
  withUnixElevation
} = require('./shared');

const PACKAGE_NAME = 'tmux';

function supports(options = {}) {
  return ['darwin', 'linux'].includes(resolvePlatform(options));
}

function resolvePackageOwner(executablePath, options = {}) {
  if (resolvePlatform(options) === 'darwin') {
    const brew = resolveCommand('brew', options);
    return brew && isHomebrewFormula(PACKAGE_NAME, executablePath, options)
      ? { id: 'homebrew', command: brew }
      : null;
  }
  return resolveLinuxPackageManager(options);
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
  const executablePath = resolveCommand(PACKAGE_NAME, options);
  const installed = Boolean(executablePath);
  const owner = resolvePackageOwner(executablePath, options);
  const config = resolveConfig(options);
  return {
    installed,
    executablePath,
    binaryName: PACKAGE_NAME,
    version: installed ? (probeVersion(executablePath, [['-V'], ['--version']], options) || '未探测到') : '-',
    managedBy: owner ? owner.id : '',
    canInstall: !installed && Boolean(resolvePackageOwner('', options)),
    canUpdate: installed && Boolean(owner),
    canUninstall: installed && Boolean(owner),
    lifecycle: {
      install: !installed && Boolean(resolvePackageOwner('', options)),
      update: installed && Boolean(owner),
      uninstall: installed && Boolean(owner)
    },
    serviceManager: serviceManagerFor(options),
    running: false,
    runningCount: 0,
    startupManaged: false,
    startupSources: [],
    ...(config ? inspectConfigTarget(config, options) : emptyConfigPresentation())
  };
}

function buildPackagePlan(action, owner, options = {}) {
  if (!owner) return [];
  const label = actionLabel(action);
  if (owner.id === 'homebrew') {
    const verb = { install: 'install', update: 'upgrade', uninstall: 'uninstall' }[action];
    return [createPlan(PACKAGE_NAME, action, owner.command, [verb, PACKAGE_NAME], {
      id: `tmux_${action}_homebrew`,
      label: `Homebrew ${label} tmux`,
      method: 'Homebrew',
      effect: `${label} Homebrew 管理的 tmux`,
      runtimeOptions: options
    })];
  }
  const packageArgs = owner[action];
  if (!Array.isArray(packageArgs)) return [];
  const elevated = withUnixElevation(owner.command, [...packageArgs, PACKAGE_NAME], options);
  return [createPlan(PACKAGE_NAME, action, elevated.command, elevated.args, {
    id: `tmux_${action}_${owner.id}`,
    label: `${owner.id} ${label} tmux`,
    method: owner.id,
    effect: `${label}系统包管理器维护的 tmux`,
    runtimeOptions: options
  })];
}

function planAction(action, context = {}) {
  const options = context.options || {};
  const tool = context.tool || detect(options);
  const owner = resolvePackageOwner(tool.executablePath, options);
  return buildPackagePlan(action, owner || resolvePackageOwner('', options), options);
}

module.exports = defineManagedToolAdapter({
  id: 'tmux',
  category: 'session-runtimes',
  name: 'tmux',
  role: 'POSIX/WSL 会话复用器',
  binaryName: 'tmux',
  versionArgs: [['-V'], ['--version']],
  capabilities: ['detect', 'version', 'sessions', 'config-edit'],
  supports,
  detect,
  resolveConfig,
  install: (context) => planAction('install', context),
  update: (context) => planAction('update', context),
  uninstall: (context) => planAction('uninstall', context)
});
