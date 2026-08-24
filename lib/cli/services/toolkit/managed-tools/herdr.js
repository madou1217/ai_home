'use strict';

const nodePath = require('node:path');
const {
  HERDR_INSTALL_PS_URL,
  HERDR_INSTALL_SHELL_URL
} = require('../../../../runtime/multiplexer/drivers/herdr-driver');
const { defineManagedToolAdapter } = require('./adapter');
const {
  actionLabel,
  createPlan,
  emptyConfigPresentation,
  isHomebrewFormula,
  pathExists,
  probeVersion,
  resolveCommand,
  resolveEnv,
  resolveHostHome,
  resolvePathApi,
  resolvePlatform,
  samePath,
  serviceManagerFor
} = require('./shared');

function supports(options = {}) {
  return ['darwin', 'linux', 'win32'].includes(resolvePlatform(options));
}

function officialCandidates(options = {}) {
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options);
  const home = resolveHostHome(options);
  if (!home) return [];
  if (platform !== 'win32') return [pathImpl.join(home, '.local', 'bin', 'herdr')];
  const env = resolveEnv(options);
  const localAppData = String(env.LOCALAPPDATA || env.LocalAppData || '').trim()
    || pathImpl.join(home, 'AppData', 'Local');
  return [
    pathImpl.join(localAppData, 'Programs', 'Herdr', 'bin', 'herdr.exe'),
    pathImpl.join(home, '.herdr', 'packages', 'standalone', 'current', 'herdr.exe')
  ];
}

function resolveExecutable(options = {}) {
  return resolveCommand('herdr', options)
    || officialCandidates(options).find((candidate) => pathExists(candidate, options))
    || '';
}

function inspectOwnership(executablePath, options = {}) {
  if (!executablePath) return { id: '', official: false, homebrew: false, external: false };
  const homebrew = isHomebrewFormula('herdr', executablePath, options);
  const official = !homebrew && officialCandidates(options)
    .some((candidate) => samePath(candidate, executablePath, options));
  return {
    id: homebrew ? 'homebrew' : official ? 'official' : 'external',
    homebrew,
    official,
    external: !homebrew && !official
  };
}

function canRemoveExecutable(executablePath, options = {}) {
  if (!executablePath) return false;
  const pathImpl = resolvePathApi(options);
  const expectedName = resolvePlatform(options) === 'win32' ? 'herdr.exe' : 'herdr';
  return pathImpl.isAbsolute(executablePath)
    && pathImpl.basename(executablePath).toLowerCase() === expectedName;
}

function detect(options = {}) {
  const executablePath = resolveExecutable(options);
  const installed = Boolean(executablePath);
  const ownership = inspectOwnership(executablePath, options);
  return {
    installed,
    executablePath,
    binaryName: resolvePlatform(options) === 'win32' ? 'herdr.exe' : 'herdr',
    version: installed ? (probeVersion(executablePath, [['--version'], ['-V']], options) || '未探测到') : '-',
    managedBy: ownership.id,
    canInstall: !installed,
    canUpdate: installed,
    canUninstall: installed && (ownership.homebrew || canRemoveExecutable(executablePath, options)),
    lifecycle: {
      install: !installed,
      update: installed,
      uninstall: installed && (ownership.homebrew || canRemoveExecutable(executablePath, options))
    },
    serviceManager: serviceManagerFor(options),
    running: false,
    runningCount: 0,
    startupManaged: false,
    startupSources: [],
    ...emptyConfigPresentation()
  };
}

function installPlan(options = {}) {
  const platform = resolvePlatform(options);
  const label = actionLabel('install');
  if (platform === 'darwin') {
    const brew = resolveCommand('brew', options);
    if (brew) {
      return [createPlan('herdr', 'install', brew, ['install', 'herdr'], {
        id: 'herdr_install_homebrew',
        label: `Homebrew ${label} Herdr`,
        method: 'Homebrew',
        effect: '安装 Homebrew 管理的 Herdr',
        runtimeOptions: options
      })];
    }
  }
  if (platform === 'win32') {
    const powershell = resolveCommand('powershell.exe', options)
      || resolveCommand('powershell', options)
      || 'powershell.exe';
    return [createPlan('herdr', 'install', powershell, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `irm ${HERDR_INSTALL_PS_URL} | iex`
    ], {
      id: 'herdr_install_official_powershell',
      label: '官方安装器安装 Herdr',
      method: 'herdr.dev 官方 PowerShell 安装器',
      effect: '下载并安装官方 Herdr Windows 发布包',
      runtimeOptions: options
    })];
  }
  const shell = resolveCommand('sh', options) || '/bin/sh';
  return [createPlan('herdr', 'install', shell, ['-c', `curl -fsSL ${HERDR_INSTALL_SHELL_URL} | sh`], {
    id: 'herdr_install_official_shell',
    label: '官方安装器安装 Herdr',
    method: 'herdr.dev 官方 Shell 安装器',
    effect: '下载校验并安装 Herdr 到用户级可执行目录',
    runtimeOptions: options
  })];
}

function updatePlan(context = {}) {
  const options = context.options || {};
  const tool = context.tool || detect(options);
  const ownership = inspectOwnership(tool.executablePath, options);
  if (ownership.homebrew) {
    const brew = resolveCommand('brew', options);
    if (!brew) return [];
    return [createPlan('herdr', 'update', brew, ['upgrade', 'herdr'], {
      id: 'herdr_update_homebrew',
      label: 'Homebrew 更新 Herdr',
      method: 'Homebrew',
      effect: '更新 Homebrew 管理的 Herdr',
      runtimeOptions: options
    })];
  }
  if (!tool.executablePath) return [];
  return [createPlan('herdr', 'update', tool.executablePath, ['update'], {
    id: 'herdr_update_direct',
    label: 'Herdr 自更新',
    method: 'herdr update',
    effect: '通过 Herdr 内置更新器更新当前安装',
    runtimeOptions: options
  })];
}

function uninstallPlan(context = {}) {
  const options = context.options || {};
  const tool = context.tool || detect(options);
  const ownership = inspectOwnership(tool.executablePath, options);
  if (ownership.homebrew) {
    const brew = resolveCommand('brew', options);
    if (!brew) return [];
    return [createPlan('herdr', 'uninstall', brew, ['uninstall', 'herdr'], {
      id: 'herdr_uninstall_homebrew',
      label: 'Homebrew 卸载 Herdr',
      method: 'Homebrew',
      effect: '卸载 Homebrew 管理的 Herdr',
      runtimeOptions: options
    })];
  }
  if (!canRemoveExecutable(tool.executablePath, options)) return [];
  const processObj = options.processObj || process;
  return [createPlan('herdr', 'uninstall', processObj.execPath || process.execPath, [
    nodePath.join(__dirname, 'herdr-uninstall-runner.js'),
    '--target',
    tool.executablePath
  ], {
    id: `herdr_uninstall_${ownership.official ? 'official' : 'exact_path'}`,
    label: '卸载 Herdr',
    method: ownership.official ? '官方安装路径清理' : '精确路径清理',
    effect: `移除当前确认的 Herdr 安装：${tool.executablePath}`,
    env: resolveHostHome(options) ? { AIH_HOST_HOME: resolveHostHome(options) } : {},
    runtimeOptions: options
  })];
}

module.exports = defineManagedToolAdapter({
  id: 'herdr',
  category: 'session-runtimes',
  name: 'herdr',
  role: '持久会话运行时',
  binaryName: 'herdr',
  versionArgs: [['--version'], ['-V']],
  capabilities: ['detect', 'version', 'sessions'],
  supports,
  detect,
  install: (context) => installPlan(context.options || {}),
  update: updatePlan,
  uninstall: uninstallPlan
});
