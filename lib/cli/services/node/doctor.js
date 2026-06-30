'use strict';

const os = require('node:os');

const {
  DEFAULT_SERVER_HOST,
  normalizeServerPort,
  formatUrlHost
} = require('../../../server/server-defaults');
const { buildRemoteNodeIdentity } = require('../../../server/remote/node-defaults');
const {
  isLoopbackHost,
  isWildcardHost,
  parseIpv4,
  isOverlayIpv4,
  isPrivateIpv4,
  isReservedIpv4,
  scoreInterfaceAddress
} = require('./join');
const {
  createNodeRelayServiceManager,
  enrichRelayServiceStatus
} = require('./relay-service');
const {
  createNodeWebrtcServiceManager,
  enrichWebrtcServiceStatus
} = require('./webrtc-service');
const {
  createFabricRegistryAgentServiceManager,
  enrichAgentServiceStatus
} = require('../fabric/registry-agent-service');

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function parseNodeDoctorArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    json: false,
    controlUrl: '',
    nodeId: ''
  };

  for (let index = 0; index < args.length;) {
    const token = nonEmptyString(args[index]);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--control-url' || token.startsWith('--control-url=')) {
      const next = readOptionValue(args, index, '--control-url');
      options.controlUrl = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')
      || token === '--id' || token.startsWith('--id=')) {
      const flag = token.startsWith('--id') ? '--id' : '--node-id';
      const next = readOptionValue(args, index, flag);
      options.nodeId = next.value;
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.controlUrl) {
      const error = new Error('too_many_control_urls');
      error.code = 'too_many_control_urls';
      throw error;
    }
    options.controlUrl = token;
    index += 1;
  }

  if (options.controlUrl) {
    options.controlUrl = normalizeControlUrl(options.controlUrl);
  }

  return options;
}

function normalizeControlUrl(value) {
  const raw = nonEmptyString(value).replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_control_url');
    error.code = 'invalid_control_url';
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('invalid_control_url');
    error.code = 'invalid_control_url';
    throw error;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function runSpawn(spawnSync, command, args, processObj) {
  if (typeof spawnSync !== 'function') {
    return { status: 1, stdout: '', stderr: 'spawnSync is not available' };
  }
  try {
    return spawnSync(command, args, {
      encoding: 'utf8',
      env: processObj && processObj.env
    });
  } catch (error) {
    return { status: 1, stdout: '', stderr: error.message || String(error), error };
  }
}

function firstOutputLine(result) {
  return String(result && result.stdout || '')
    .split(/\r?\n/)
    .map((line) => nonEmptyString(line))
    .find(Boolean) || '';
}

function resolveCommandPath(command, deps = {}) {
  const processObj = deps.processObj || process;
  const spawnSync = deps.spawnSync;
  if (processObj.platform === 'win32') {
    return firstOutputLine(runSpawn(spawnSync, 'where', [command], processObj));
  }
  return firstOutputLine(runSpawn(spawnSync, 'sh', ['-lc', `command -v ${command}`], processObj));
}

function readCommandVersion(command, deps = {}) {
  const result = runSpawn(deps.spawnSync, command, ['--version'], deps.processObj || process);
  if (result.status !== 0) return '';
  return firstOutputLine(result);
}

function inspectCommand(command, deps = {}, options = {}) {
  const commandPath = resolveCommandPath(command, deps);
  const version = commandPath && options.version !== false
    ? readCommandVersion(command, deps)
    : '';
  return {
    ok: Boolean(commandPath),
    path: commandPath,
    version
  };
}

function resolveEnvAihPath(deps = {}) {
  const processObj = deps.processObj || process;
  const fs = deps.fs;
  const value = nonEmptyString(processObj.env && processObj.env.AIH_CLI_PATH);
  if (!value) return null;
  const canCheckFile = fs && typeof fs.existsSync === 'function';
  return {
    ok: canCheckFile ? fs.existsSync(value) : true,
    path: value,
    version: '',
    source: 'AIH_CLI_PATH'
  };
}

function inspectAihCli(deps = {}) {
  const envPath = resolveEnvAihPath(deps);
  if (envPath) return envPath;
  return {
    ...inspectCommand('aih', deps, { version: false }),
    source: 'PATH'
  };
}

function inspectCli(deps = {}) {
  const processObj = deps.processObj || process;
  const node = inspectCommand('node', deps);
  const currentVersion = nonEmptyString(processObj.version) || process.version;
  const currentExecPath = nonEmptyString(processObj.execPath) || process.execPath;
  return {
    node: {
      ...node,
      ok: node.ok || Boolean(currentVersion),
      version: node.version || currentVersion,
      currentVersion,
      currentExecPath
    },
    npm: inspectCommand('npm', deps),
    aih: inspectAihCli(deps)
  };
}

function classifyIpv4Address(address) {
  const octets = parseIpv4(address);
  if (!octets) return 'unknown';
  if (isOverlayIpv4(octets)) return 'overlay';
  if (isPrivateIpv4(octets)) return 'private';
  if (octets[0] === 127) return 'loopback';
  if (isReservedIpv4(octets)) return 'reserved';
  return 'public';
}

function listNetworkCandidates(networkInterfaces) {
  const interfaces = typeof networkInterfaces === 'function' ? networkInterfaces() : os.networkInterfaces();
  const candidates = [];
  Object.entries(interfaces || {}).forEach(([interfaceName, items]) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || item.internal) return;
      if (item.family !== 'IPv4' && item.family !== 4) return;
      const address = nonEmptyString(item.address);
      const score = scoreInterfaceAddress(address);
      if (!address || score <= 0) return;
      candidates.push({
        interfaceName,
        address,
        family: 'IPv4',
        kind: classifyIpv4Address(address),
        score
      });
    });
  });
  candidates.sort((left, right) => right.score - left.score
    || left.interfaceName.localeCompare(right.interfaceName)
    || left.address.localeCompare(right.address));
  return candidates;
}

function resolveHostname(deps = {}) {
  if (typeof deps.hostname === 'function') {
    const value = nonEmptyString(deps.hostname());
    if (value) return value;
  }
  return nonEmptyString(os.hostname()) || 'ai-home-node';
}

function resolveServerDiagnostics(serverConfig, networkCandidates) {
  const host = nonEmptyString(serverConfig.host) || DEFAULT_SERVER_HOST;
  const port = normalizeServerPort(serverConfig.port);
  const managementKeyConfigured = Boolean(nonEmptyString(serverConfig.managementKey));
  const loopback = isLoopbackHost(host);
  const wildcard = isWildcardHost(host);
  const advertised = wildcard && networkCandidates.length ? networkCandidates[0] : null;
  const endpointHost = wildcard && advertised ? advertised.address : (loopback ? '' : host);
  const endpointCandidate = endpointHost ? `http://${formatUrlHost(endpointHost)}:${port}` : '';
  const endpointKind = advertised ? advertised.kind : (endpointHost ? classifyIpv4Address(endpointHost) : 'none');
  const directReachable = Boolean(endpointCandidate) && !loopback;

  return {
    host,
    port,
    listen: `http://${formatUrlHost(host)}:${port}`,
    managementKeyConfigured,
    directReachable,
    directReachableHint: resolveDirectReachableHint({ loopback, wildcard, endpointCandidate, endpointKind }),
    endpointCandidate,
    endpointKind,
    advertisedHost: endpointHost,
    listenScope: loopback ? 'loopback' : (wildcard ? 'wildcard' : 'configured')
  };
}

function resolveDirectReachableHint(input) {
  if (input.loopback) return 'local-only';
  if (!input.endpointCandidate) return 'no-interface-candidate';
  if (input.endpointKind === 'overlay') return 'overlay-direct';
  if (input.endpointKind === 'private') return 'lan-only';
  if (input.endpointKind === 'public') return 'public-direct';
  return 'configured-host';
}

function resolveBasicServiceDiagnostics(platform, controlUrl, nodeId) {
  const types = {
    darwin: 'launchd',
    linux: 'systemd-user',
    win32: 'windows-startup'
  };
  const type = types[platform] || platform || 'unknown';
  const supported = Boolean(types[platform]);
  return {
    supported,
    type,
    installHint: supported
      ? buildRelayServiceInstallHint(controlUrl, nodeId)
      : ''
  };
}

function buildRegistryAgentServiceInstallHint(controlUrl, nodeId) {
  const url = nonEmptyString(controlUrl) || '<server-url>';
  const id = nonEmptyString(nodeId) || '<node-id>';
  return `aih fabric registry agent service install ${url} --node-id ${id} --token-file '<token-file>'`;
}

function resolveBasicRegistryAgentServiceDiagnostics(platform, controlUrl, nodeId) {
  const types = {
    darwin: 'launchd',
    linux: 'systemd-user',
    win32: 'windows-startup'
  };
  const type = types[platform] || platform || 'unknown';
  const supported = Boolean(types[platform]);
  return {
    supported,
    type,
    installHint: supported
      ? buildRegistryAgentServiceInstallHint(controlUrl, nodeId)
      : ''
  };
}

function buildWebrtcServiceInstallHint(controlUrl, nodeId) {
  const url = nonEmptyString(controlUrl) || '<control-url>';
  const id = nonEmptyString(nodeId) || '<node-id>';
  return `aih node webrtc service install ${url} --node-id ${id}`;
}

function resolveBasicWebrtcServiceDiagnostics(platform, controlUrl, nodeId) {
  const types = {
    darwin: 'launchd',
    linux: 'systemd-user',
    win32: 'windows-startup'
  };
  const type = types[platform] || platform || 'unknown';
  const supported = Boolean(types[platform]);
  return {
    supported,
    type,
    installHint: supported
      ? buildWebrtcServiceInstallHint(controlUrl, nodeId)
      : ''
  };
}

function resolveServiceDiagnostics(platform, controlUrl, nodeId, deps = {}) {
  const fallback = resolveBasicServiceDiagnostics(platform, controlUrl, nodeId);
  if (!fallback.supported) return fallback;
  try {
    const manager = createNodeRelayServiceManager({ nodeId }, {
      ...deps,
      processObj: resolveProcessContext(deps.processObj, platform, deps.arch || process.arch)
    });
    return {
      ...fallback,
      ...enrichRelayServiceStatus(manager.getStatus(), { controlUrl, nodeId })
    };
  } catch (error) {
    return {
      ...fallback,
      state: 'unknown',
      running: false,
      issues: [{
        severity: 'warning',
        code: 'relay_service_status_unavailable',
        message: String((error && error.message) || error || 'relay service status unavailable')
      }],
      nextActions: [{
        label: 'Check relay service status',
        command: `aih node relay service status --node-id ${nonEmptyString(nodeId) || '<node-id>'}`
      }]
    };
  }
}

function resolveRegistryAgentServiceDiagnostics(platform, controlUrl, nodeId, deps = {}) {
  const fallback = resolveBasicRegistryAgentServiceDiagnostics(platform, controlUrl, nodeId);
  if (!fallback.supported) {
    return {
      supported: false,
      type: fallback.type,
      installHint: ''
    };
  }
  try {
    const manager = createFabricRegistryAgentServiceManager({ nodeId }, {
      ...deps,
      processObj: resolveProcessContext(deps.processObj, platform, deps.arch || process.arch)
    });
    return {
      ...fallback,
      ...enrichAgentServiceStatus(manager.getStatus(), {
        endpoint: nonEmptyString(controlUrl) || '<server-url>',
        nodeId,
        tokenFile: '<token-file>'
      })
    };
  } catch (error) {
    return {
      ...fallback,
      state: 'unknown',
      running: false,
      issues: [{
        severity: 'warning',
        code: 'fabric_agent_service_status_unavailable',
        message: String((error && error.message) || error || 'fabric registry agent service status unavailable')
      }],
      nextActions: [{
        label: 'Check Fabric agent service status',
        command: `aih fabric registry agent service status --node-id ${nonEmptyString(nodeId) || '<node-id>'}`
      }]
    };
  }
}

function resolveWebrtcServiceDiagnostics(platform, controlUrl, nodeId, deps = {}) {
  const fallback = resolveBasicWebrtcServiceDiagnostics(platform, controlUrl, nodeId);
  if (!fallback.supported) {
    return {
      supported: false,
      type: fallback.type,
      installHint: ''
    };
  }
  try {
    const manager = createNodeWebrtcServiceManager({ nodeId }, {
      ...deps,
      processObj: resolveProcessContext(deps.processObj, platform, deps.arch || process.arch)
    });
    return {
      ...fallback,
      ...enrichWebrtcServiceStatus(manager.getStatus(), { controlUrl, nodeId })
    };
  } catch (error) {
    return {
      ...fallback,
      state: 'unknown',
      running: false,
      issues: [{
        severity: 'warning',
        code: 'webrtc_service_status_unavailable',
        message: String((error && error.message) || error || 'WebRTC connector service status unavailable')
      }],
      nextActions: [{
        label: 'Check WebRTC connector service status',
        command: `aih node webrtc service status --node-id ${nonEmptyString(nodeId) || '<node-id>'}`
      }]
    };
  }
}

function summarizeServiceReadiness(key, label, status = {}) {
  if (!status.supported) {
    return {
      key,
      label,
      ready: false,
      severity: 'warning',
      code: `${key}_service_unsupported`,
      message: `${label} service is not supported on this platform.`
    };
  }
  if (!status.running) {
    return {
      key,
      label,
      ready: false,
      severity: 'warning',
      code: `${key}_service_not_running`,
      message: `${label} service is not running.`
    };
  }
  return {
    key,
    label,
    ready: true,
    severity: 'info',
    code: `${key}_service_running`,
    message: `${label} service is running.`
  };
}

function resolveNodeSupervisorDiagnostics(services = {}) {
  const required = [
    summarizeServiceReadiness('relay', 'Relay', services.relay),
    summarizeServiceReadiness('registry_agent', 'Fabric registry agent', services.registryAgent),
    summarizeServiceReadiness('webrtc', 'WebRTC connector', services.webrtc)
  ];
  const issues = required
    .filter((item) => !item.ready)
    .map(({ severity, code, message, key, label }) => ({ severity, code, message, key, label }));
  return {
    ready: issues.length === 0,
    required: required.map(({ key, label, ready }) => ({ key, label, ready })),
    issues
  };
}

function buildRelayServiceInstallHint(controlUrl, nodeId) {
  const url = nonEmptyString(controlUrl) || '<control-url>';
  const id = nonEmptyString(nodeId) || '<node-id>';
  return `aih node relay service install ${url} --node-id ${id}`;
}

function resolveRelayDiagnostics(server, controlUrl, nodeId) {
  const commandHint = 'aih node join <invite-url> --transport relay';
  if (!server.managementKeyConfigured) {
    return {
      recommended: true,
      reason: 'managementKey is required before relay or remote management can authenticate',
      commandHint,
      serviceHint: buildRelayServiceInstallHint(controlUrl, nodeId)
    };
  }
  if (!server.endpointCandidate) {
    return {
      recommended: true,
      reason: 'no direct endpoint candidate was detected',
      commandHint,
      serviceHint: buildRelayServiceInstallHint(controlUrl, nodeId)
    };
  }
  if (server.endpointKind === 'overlay' || server.endpointKind === 'public') {
    return {
      recommended: false,
      reason: `${server.endpointKind} endpoint candidate is available`,
      commandHint,
      serviceHint: buildRelayServiceInstallHint(controlUrl, nodeId)
    };
  }
  return {
    recommended: true,
    reason: 'private/LAN endpoints usually fail across NAT; relay keeps no-public-IP setup minimal',
    commandHint,
    serviceHint: buildRelayServiceInstallHint(controlUrl, nodeId)
  };
}

function addIssue(issues, severity, code, message) {
  issues.push({ severity, code, message });
}

function collectIssues(report) {
  const issues = [];
  if (!report.cli.node.ok) {
    addIssue(issues, 'blocker', 'node_runtime_missing', 'node command was not found on PATH');
  }
  if (!report.cli.npm.ok) {
    addIssue(issues, 'warning', 'npm_missing', 'npm command was not found on PATH');
  }
  if (!report.cli.aih.ok) {
    addIssue(issues, 'warning', 'aih_cli_missing', 'aih command was not found; relay service install needs a PATH entry or AIH_CLI_PATH');
  }
  if (!report.server.managementKeyConfigured) {
    addIssue(issues, 'blocker', 'management_key_missing', 'server managementKey is required for remote node authentication');
  }
  if (report.server.listenScope === 'loopback') {
    addIssue(issues, 'warning', 'server_loopback_only', 'server listens on loopback; direct remote access needs relay, overlay, FRP, SSH tunnel, or a non-loopback endpoint');
  }
  if (!report.server.endpointCandidate) {
    addIssue(issues, 'warning', 'endpoint_candidate_missing', 'no non-internal IPv4 endpoint candidate was detected');
  }
  if (!report.service.supported) {
    addIssue(issues, 'warning', 'relay_service_unsupported', `relay service install is not supported on ${report.platform}`);
  }
  if (report.platform === 'win32') {
    addIssue(issues, 'info', 'windows_bootstrap_note', 'if SSH/WinRM is disabled, bootstrap must start through RDP, SMB, or another remote-assist tool first');
  }
  return issues;
}

function buildNextSteps(report) {
  const steps = [];
  const registryAgent = report.services && report.services.registryAgent || {};
  const webrtc = report.services && report.services.webrtc || {};
  const registryAgentInstall = registryAgent.commands && registryAgent.commands.install
    ? registryAgent.commands.install
    : (registryAgent.installHint || '');
  const webrtcInstall = webrtc.commands && webrtc.commands.install
    ? webrtc.commands.install
    : (webrtc.installHint || '');
  const appendRegistryAgentStep = () => {
    if (registryAgent.supported && !registryAgent.running && registryAgentInstall) {
      steps.push(`Install Fabric registry agent after saving a device token file: ${registryAgentInstall}`);
    }
  };
  const appendWebrtcStep = () => {
    if (webrtc.supported && !webrtc.running && webrtcInstall) {
      steps.push(`Install persistent WebRTC connector after join: ${webrtcInstall}`);
    }
  };

  if (!report.server.managementKeyConfigured) {
    steps.push('Set server managementKey before joining this machine as a remote node.');
  }
  if (report.relay.recommended) {
    steps.push(`Join with relay after generating an invite on the Control Plane: ${report.relay.commandHint}`);
    if (report.service.supported) steps.push(`Install persistent relay after join: ${report.service.installHint}`);
    appendRegistryAgentStep();
    appendWebrtcStep();
    return steps;
  }
  if (report.server.endpointCandidate) {
    const kind = report.server.endpointKind === 'overlay' ? 'tailscale' : 'direct';
    steps.push(`Direct/overlay join is possible: aih node join <invite-url> --endpoint ${report.server.endpointCandidate} --transport ${kind}`);
  }
  steps.push(`Relay remains available for no-public-IP machines: ${report.relay.commandHint}`);
  if (report.service.supported) steps.push(`Persistent relay service: ${report.service.installHint}`);
  appendRegistryAgentStep();
  appendWebrtcStep();
  return steps;
}

function resolveProcessContext(processObj, platform, arch) {
  const source = processObj || process;
  return {
    env: source.env,
    getuid: typeof source.getuid === 'function' ? source.getuid.bind(source) : undefined,
    execPath: source.execPath,
    version: source.version,
    platform,
    arch
  };
}

function resolveLinuxUserRuntimeEnv(processObj = {}) {
  const env = { ...(processObj.env || {}) };
  if (env.XDG_RUNTIME_DIR && env.DBUS_SESSION_BUS_ADDRESS) return env;

  const uid = typeof processObj.getuid === 'function'
    ? processObj.getuid()
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) return env;

  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  env.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

function createServiceStatusSpawnSync(spawnSync, processObj, platform) {
  if (typeof spawnSync !== 'function' || platform !== 'linux') return spawnSync;
  const systemdEnv = resolveLinuxUserRuntimeEnv(processObj);
  return (command, args = [], options = {}) => {
    if (command === 'systemctl' && Array.isArray(args) && args[0] === '--user') {
      return spawnSync(command, args, {
        ...options,
        env: {
          ...systemdEnv,
          ...(options.env || {})
        }
      });
    }
    return spawnSync(command, args, options);
  };
}

function buildNodeDoctorReport(input = {}, deps = {}) {
  const options = input && typeof input === 'object' ? input : {};
  const processObj = deps.processObj || process;
  const platform = nonEmptyString(deps.platform || processObj.platform) || process.platform;
  const arch = nonEmptyString(deps.arch || processObj.arch) || process.arch;
  const processContext = resolveProcessContext(processObj, platform, arch);
  const serviceDeps = {
    ...deps,
    processObj: processContext,
    spawnSync: createServiceStatusSpawnSync(deps.spawnSync, processContext, platform)
  };
  const hostname = resolveHostname(deps);
  const identity = buildRemoteNodeIdentity({
    id: options.nodeId,
    name: hostname
  }, { ...serviceDeps, platform, arch });
  const cli = inspectCli({
    ...deps,
    processObj: processContext
  });
  const networkCandidates = listNetworkCandidates(deps.networkInterfaces);
  const server = resolveServerDiagnostics(readServerConfigSafe(deps.readServerConfig), networkCandidates);
  const service = resolveServiceDiagnostics(platform, options.controlUrl, identity.nodeId, serviceDeps);
  const registryAgentService = resolveRegistryAgentServiceDiagnostics(platform, options.controlUrl, identity.nodeId, serviceDeps);
  const webrtcService = resolveWebrtcServiceDiagnostics(platform, options.controlUrl, identity.nodeId, serviceDeps);
  const services = {
    relay: service,
    registryAgent: registryAgentService,
    webrtc: webrtcService
  };
  const relay = resolveRelayDiagnostics(server, options.controlUrl, identity.nodeId);
  const report = {
    ok: true,
    platform,
    arch,
    hostname,
    node: {
      id: identity.nodeId,
      name: identity.name
    },
    cli,
    server,
    network: {
      candidates: networkCandidates,
      advertisedHost: server.advertisedHost
    },
    relay,
    services,
    nodeSupervisor: resolveNodeSupervisorDiagnostics(services),
    service,
    issues: [],
    nextSteps: []
  };
  report.issues = collectIssues(report);
  report.ok = !report.issues.some((issue) => issue.severity === 'blocker');
  report.nextSteps = buildNextSteps(report);
  return report;
}

function formatCommandStatus(command) {
  if (!command || !command.ok) return 'missing';
  const version = nonEmptyString(command.version);
  const path = nonEmptyString(command.path || command.currentExecPath);
  return [version || 'ok', path ? `(${path})` : ''].filter(Boolean).join(' ');
}

function formatDoctorReport(report) {
  const registryAgent = report.services && report.services.registryAgent || {};
  const webrtc = report.services && report.services.webrtc || {};
  const supervisor = report.nodeSupervisor || {};
  const lines = [
    '[aih] node doctor',
    `[aih] platform: ${report.platform}/${report.arch}`,
    `[aih] hostname: ${report.hostname}`,
    `[aih] default node: ${report.node.name} (${report.node.id})`,
    `[aih] node: ${formatCommandStatus(report.cli.node)}`,
    `[aih] npm: ${formatCommandStatus(report.cli.npm)}`,
    `[aih] aih cli: ${formatCommandStatus(report.cli.aih)}`,
    `[aih] server: ${report.server.listen}`,
    `[aih] management key: ${report.server.managementKeyConfigured ? 'configured' : 'missing'}`,
    `[aih] endpoint candidate: ${report.server.endpointCandidate || 'none'} (${report.server.directReachableHint})`,
    `[aih] relay: ${report.relay.recommended ? 'recommended' : 'optional'} - ${report.relay.reason}`,
    `[aih] service: ${report.service.supported ? 'supported' : 'unsupported'} (${report.service.type}, ${report.service.state || 'unknown'})`,
    `[aih] service running: ${report.service.running ? 'yes' : 'no'}`,
    `[aih] registry agent service: ${registryAgent.supported ? 'supported' : 'unsupported'} (${registryAgent.type || 'unknown'}, ${registryAgent.state || 'unknown'})`,
    `[aih] registry agent running: ${registryAgent.running ? 'yes' : 'no'}`,
    `[aih] webrtc service: ${webrtc.supported ? 'supported' : 'unsupported'} (${webrtc.type || 'unknown'}, ${webrtc.state || 'unknown'})`,
    `[aih] webrtc running: ${webrtc.running ? 'yes' : 'no'}`,
    `[aih] node supervisor: ${supervisor.ready ? 'ready' : 'not ready'}`
  ];

  if (report.network.candidates.length) {
    lines.push('[aih] network candidates:');
    report.network.candidates.slice(0, 5).forEach((candidate) => {
      lines.push(`  - ${candidate.interfaceName}: ${candidate.address} (${candidate.kind}, score ${candidate.score})`);
    });
  }

  if (report.issues.length) {
    lines.push('[aih] issues:');
    report.issues.forEach((issue) => {
      lines.push(`  - ${issue.severity}:${issue.code} ${issue.message}`);
    });
  }

  if (Array.isArray(report.service.issues) && report.service.issues.length) {
    lines.push('[aih] relay service issues:');
    report.service.issues.forEach((issue) => {
      lines.push(`  - ${issue.severity || 'warning'}:${issue.code || 'issue'} ${issue.message || ''}`);
    });
  }

  if (Array.isArray(registryAgent.issues) && registryAgent.issues.length) {
    lines.push('[aih] registry agent service issues:');
    registryAgent.issues.forEach((issue) => {
      lines.push(`  - ${issue.severity || 'warning'}:${issue.code || 'issue'} ${issue.message || ''}`);
    });
  }

  if (Array.isArray(webrtc.issues) && webrtc.issues.length) {
    lines.push('[aih] webrtc service issues:');
    webrtc.issues.forEach((issue) => {
      lines.push(`  - ${issue.severity || 'warning'}:${issue.code || 'issue'} ${issue.message || ''}`);
    });
  }

  if (Array.isArray(supervisor.issues) && supervisor.issues.length) {
    lines.push('[aih] node supervisor issues:');
    supervisor.issues.forEach((issue) => {
      lines.push(`  - ${issue.severity || 'warning'}:${issue.code || 'issue'} ${issue.message || ''}`);
    });
  }

  if (report.nextSteps.length) {
    lines.push('[aih] next steps:');
    report.nextSteps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step}`);
    });
  }

  if (Array.isArray(report.service.nextActions) && report.service.nextActions.length) {
    lines.push('[aih] relay service next actions:');
    report.service.nextActions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${action.label}: ${action.command}`);
    });
  }

  if (Array.isArray(registryAgent.nextActions) && registryAgent.nextActions.length) {
    lines.push('[aih] registry agent service next actions:');
    registryAgent.nextActions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${action.label}: ${action.command}`);
    });
  }

  if (Array.isArray(webrtc.nextActions) && webrtc.nextActions.length) {
    lines.push('[aih] webrtc service next actions:');
    webrtc.nextActions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${action.label}: ${action.command}`);
    });
  }

  return lines.join('\n');
}

function runNodeDoctor(rawArgs = [], deps = {}) {
  const options = parseNodeDoctorArgs(rawArgs);
  const report = buildNodeDoctorReport(options, deps);
  return {
    ok: true,
    json: Boolean(options.json),
    report
  };
}

module.exports = {
  parseNodeDoctorArgs,
  listNetworkCandidates,
  buildNodeDoctorReport,
  formatDoctorReport,
  runNodeDoctor
};
