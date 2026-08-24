'use strict';

const { getConfigFormat } = require('../config-editor');
const { discoverNetworkTools } = require('../network-tool-discovery');
const { resolveLinuxToolPlans } = require('../tool-lifecycle/platforms/linux');
const { resolveMacosToolPlans } = require('../tool-lifecycle/platforms/macos');
const { resolveWindowsToolPlans } = require('../tool-lifecycle/platforms/windows');
const {
  inspectFrpcOwnership,
  normalizeArch,
  resolveManagedFrpcPath
} = require('../tool-lifecycle/shared');
const { defineManagedToolAdapter } = require('./adapter');
const {
  emptyConfigPresentation,
  inspectConfigTarget,
  pathExists,
  probeVersion,
  resolveCommand,
  resolvePathApi,
  resolvePlatform,
  serviceManagerFor
} = require('./shared');

function supports(options = {}) {
  return ['darwin', 'linux', 'win32'].includes(resolvePlatform(options));
}

function resolveRuntime(options = {}) {
  return options.networkRuntime && options.networkRuntime.frpc
    ? options.networkRuntime.frpc
    : discoverNetworkTools(options).frpc;
}

function resolveConfig(options = {}) {
  const runtime = resolveRuntime(options);
  return {
    targetPath: String(runtime.configPath || ''),
    name: runtime.configPath ? resolvePathApi(options).basename(runtime.configPath) : '',
    format: runtime.configPath ? getConfigFormat(runtime.configPath) : 'toml',
    allowMissing: false,
    count: Number(runtime.configCount || 0),
    ambiguous: Boolean(runtime.configAmbiguous),
    state: String(runtime.configState || 'none'),
    source: String(runtime.configSource || '')
  };
}

function configPresentation(options = {}) {
  const target = resolveConfig(options);
  if (target.targetPath) return inspectConfigTarget(target, options);
  return {
    ...emptyConfigPresentation(),
    configFormat: target.format,
    configCount: target.count,
    configAmbiguous: target.ambiguous,
    configState: target.state,
    configSource: target.source
  };
}

function detect(options = {}) {
  const runtime = resolveRuntime(options);
  const managedCandidate = resolveManagedFrpcPath(options);
  const managedCandidateExists = pathExists(managedCandidate, options);
  const resolvedCommand = resolveCommand('frpc', options);
  const executablePath = (managedCandidateExists ? managedCandidate : '')
    || resolvedCommand
    || (runtime.executableExists || runtime.running ? String(runtime.executablePath || '').trim() : '')
    || '';
  const installed = Boolean(executablePath || runtime.running);
  const ownership = installed
    ? inspectFrpcOwnership(executablePath, options)
    : { managed: false, homebrew: false, external: false };
  const releaseSupported = Boolean(normalizeArch(options));
  const owned = ownership.managed || ownership.homebrew || ownership.external;
  const canInstall = !installed && releaseSupported;
  const canUpdate = installed && owned && releaseSupported;
  const canUninstall = installed && owned;
  return {
    installed,
    executablePath,
    managedPath: managedCandidate,
    binaryName: resolvePlatform(options) === 'win32' ? 'frpc.exe' : 'frpc',
    version: executablePath ? (probeVersion(executablePath, [['--version'], ['-v']], options) || '未探测到') : '-',
    managedBy: ownership.homebrew ? 'homebrew' : ownership.managed ? 'aih' : ownership.external ? 'external' : '',
    canInstall,
    canUpdate,
    canUninstall,
    lifecycle: { install: canInstall, update: canUpdate, uninstall: canUninstall },
    serviceManager: serviceManagerFor(options),
    running: Boolean(runtime.running),
    runningCount: Number(runtime.runningCount || 0),
    startupManaged: Boolean(runtime.startupManaged),
    startupSources: runtime.startupSources || [],
    ...configPresentation({ ...options, networkRuntime: { frpc: runtime } })
  };
}

function planAction(action, context = {}) {
  const options = context.options || {};
  const tool = context.tool || detect(options);
  if (action !== 'uninstall' && !normalizeArch(options)) {
    return {
      ok: false,
      error: 'unsupported_architecture',
      message: '当前 CPU 架构没有可用的 frpc 官方发布包。'
    };
  }
  const ownership = inspectFrpcOwnership(tool.executablePath, options);
  const platform = resolvePlatform(options);
  if (platform === 'darwin') return resolveMacosToolPlans('frpc', action, ownership, options);
  if (platform === 'win32') return resolveWindowsToolPlans('frpc', action, ownership, options);
  return resolveLinuxToolPlans('frpc', action, ownership, options);
}

module.exports = defineManagedToolAdapter({
  id: 'frpc',
  category: 'network-access',
  name: 'frpc',
  role: 'FRP 客户端反向隧道',
  binaryName: 'frpc',
  versionArgs: [['--version'], ['-v']],
  capabilities: ['detect', 'version', 'config-edit'],
  runtimeInspectable: true,
  supports,
  detect,
  resolveConfig,
  install: (context) => planAction('install', context),
  update: (context) => planAction('update', context),
  uninstall: (context) => planAction('uninstall', context)
});
