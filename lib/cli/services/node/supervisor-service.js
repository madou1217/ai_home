'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  buildNodeDoctorReport,
  parseNodeDoctorArgs
} = require('./doctor');
const { runNodeRelayService } = require('./relay-service');
const { runNodeWebrtcService } = require('./webrtc-service');
const { runFabricRegistryAgentService } = require('../fabric/registry-agent-service');

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

function resolveHomePath(value, env = process.env) {
  const text = nonEmptyString(value);
  if (!text) return '';
  if (text === '~') return nonEmptyString(env.HOME || env.USERPROFILE) || text;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    const home = nonEmptyString(env.HOME || env.USERPROFILE);
    return home ? path.join(home, text.slice(2)) : text;
  }
  return text;
}

function normalizeControlUrl(value) {
  return parseNodeDoctorArgs(['--control-url', value]).controlUrl;
}

function parseNodeSupervisorServiceArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const action = nonEmptyString(args[0]);
  if (!action) {
    const error = new Error('missing_node_service_action');
    error.code = 'missing_node_service_action';
    throw error;
  }
  if (action === 'status') {
    return {
      action,
      ...parseNodeDoctorArgs(args.slice(1))
    };
  }
  if (action === 'uninstall') {
    return parseNodeSupervisorUninstallArgs(args);
  }
  if (action !== 'install') {
    const error = new Error(`unknown_node_service_action:${action}`);
    error.code = 'unknown_node_service_action';
    error.action = action;
    throw error;
  }

  return parseNodeSupervisorInstallArgs(args, deps);
}

function parseNodeSupervisorUninstallArgs(args = []) {
  const options = {
    action: 'uninstall',
    nodeId: '',
    json: false,
    yes: false,
    dryRun: false
  };

  for (let index = 1; index < args.length;) {
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
    if (token === '--yes') {
      options.yes = true;
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      index += 1;
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
    if (token === '--control-url' || token.startsWith('--control-url=')
      || token === '--token-file' || token.startsWith('--token-file=')
      || token === '--token' || token.startsWith('--token=')
      || token === '--management-key' || token.startsWith('--management-key=')
      || token === '--heartbeat-ms' || token.startsWith('--heartbeat-ms=')
      || token === '--connect-timeout-ms' || token.startsWith('--connect-timeout-ms=')
      || token === '--reconnect-delay-ms' || token.startsWith('--reconnect-delay-ms=')
      || token === '--status' || token.startsWith('--status=')
      || token === '--relay-status' || token.startsWith('--relay-status=')
      || token === '--transport' || token.startsWith('--transport=')
      || token === '--probe-transport' || token.startsWith('--probe-transport=')
      || token === '--probe-timeout-ms' || token.startsWith('--probe-timeout-ms=')
      || token === '--probe-method' || token.startsWith('--probe-method=')
      || token === '--probe-count' || token.startsWith('--probe-count=')
      || token === '--probe-payload-size' || token.startsWith('--probe-payload-size=')
      || token === '--interval-ms' || token.startsWith('--interval-ms=')
      || token === '--once' || token === '--count' || token.startsWith('--count=')) {
      const error = new Error(`node_service_option_not_allowed:${token}`);
      error.code = 'node_service_option_not_allowed';
      error.flag = token.split('=')[0];
      throw error;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    const error = new Error(`unexpected_node_service_argument:${token}`);
    error.code = 'unexpected_node_service_argument';
    error.argument = token;
    throw error;
  }

  if (!options.nodeId) {
    const error = new Error('missing_node_service_node_id');
    error.code = 'missing_node_service_node_id';
    throw error;
  }

  return options;
}

function parseNodeSupervisorInstallArgs(args = [], deps = {}) {
  const env = deps.env || process.env || {};
  const options = {
    action: 'install',
    controlUrl: '',
    nodeId: '',
    tokenFile: '',
    json: false,
    yes: false,
    dryRun: false,
    relay: {
      heartbeatMs: '',
      connectTimeoutMs: '',
      reconnectDelayMs: ''
    },
    webrtc: {
      connectTimeoutMs: '',
      reconnectDelayMs: ''
    },
    registryAgent: {
      status: '',
      relayStatus: '',
      transports: [],
      probeTransports: [],
      probeTimeoutMs: '',
      probeMethod: '',
      probeCount: '',
      probePayloadSize: '',
      intervalMs: ''
    }
  };

  for (let index = 1; index < args.length;) {
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
    if (token === '--yes') {
      options.yes = true;
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      index += 1;
      continue;
    }
    if (token === '--control-url' || token.startsWith('--control-url=')) {
      const next = readOptionValue(args, index, '--control-url');
      options.controlUrl = normalizeControlUrl(next.value);
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
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const next = readOptionValue(args, index, '--token-file');
      options.tokenFile = path.resolve(resolveHomePath(next.value, env));
      index += next.consumed;
      continue;
    }
    if (token === '--heartbeat-ms' || token.startsWith('--heartbeat-ms=')) {
      const next = readOptionValue(args, index, '--heartbeat-ms');
      options.relay.heartbeatMs = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--connect-timeout-ms' || token.startsWith('--connect-timeout-ms=')) {
      const next = readOptionValue(args, index, '--connect-timeout-ms');
      options.relay.connectTimeoutMs = next.value;
      options.webrtc.connectTimeoutMs = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--reconnect-delay-ms' || token.startsWith('--reconnect-delay-ms=')) {
      const next = readOptionValue(args, index, '--reconnect-delay-ms');
      options.relay.reconnectDelayMs = next.value;
      options.webrtc.reconnectDelayMs = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--status' || token.startsWith('--status=')) {
      const next = readOptionValue(args, index, '--status');
      options.registryAgent.status = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--relay-status' || token.startsWith('--relay-status=')) {
      const next = readOptionValue(args, index, '--relay-status');
      options.registryAgent.relayStatus = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')) {
      const next = readOptionValue(args, index, '--transport');
      options.registryAgent.transports.push(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-transport' || token.startsWith('--probe-transport=')) {
      const next = readOptionValue(args, index, '--probe-transport');
      options.registryAgent.probeTransports.push(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-timeout-ms' || token.startsWith('--probe-timeout-ms=')) {
      const next = readOptionValue(args, index, '--probe-timeout-ms');
      options.registryAgent.probeTimeoutMs = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--probe-method' || token.startsWith('--probe-method=')) {
      const next = readOptionValue(args, index, '--probe-method');
      options.registryAgent.probeMethod = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--probe-count' || token.startsWith('--probe-count=')) {
      const next = readOptionValue(args, index, '--probe-count');
      options.registryAgent.probeCount = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--probe-payload-size' || token.startsWith('--probe-payload-size=')) {
      const next = readOptionValue(args, index, '--probe-payload-size');
      options.registryAgent.probePayloadSize = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--interval-ms' || token.startsWith('--interval-ms=')) {
      const next = readOptionValue(args, index, '--interval-ms');
      options.registryAgent.intervalMs = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')
      || token === '--management-key' || token.startsWith('--management-key=')
      || token === '--once' || token === '--count' || token.startsWith('--count=')) {
      const error = new Error(`node_service_option_not_allowed:${token}`);
      error.code = 'node_service_option_not_allowed';
      error.flag = token.split('=')[0];
      throw error;
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
    options.controlUrl = normalizeControlUrl(token);
    index += 1;
  }

  if (!options.controlUrl) {
    const error = new Error('missing_node_service_control_url');
    error.code = 'missing_node_service_control_url';
    throw error;
  }
  if (!options.nodeId) {
    const error = new Error('missing_node_service_node_id');
    error.code = 'missing_node_service_node_id';
    throw error;
  }
  if (!options.tokenFile) {
    const error = new Error('missing_node_service_token_file');
    error.code = 'missing_node_service_token_file';
    throw error;
  }

  return options;
}

function buildNodeSupervisorServiceStatus(report = {}) {
  const services = report.services || {};
  return {
    ok: Boolean(report.ok && report.nodeSupervisor && report.nodeSupervisor.ready),
    platform: report.platform,
    arch: report.arch,
    hostname: report.hostname,
    node: report.node,
    server: {
      listen: report.server && report.server.listen || '',
      listenScope: report.server && report.server.listenScope || '',
      managementKeyConfigured: Boolean(report.server && report.server.managementKeyConfigured),
      endpointCandidate: report.server && report.server.endpointCandidate || '',
      directReachableHint: report.server && report.server.directReachableHint || ''
    },
    supervisor: report.nodeSupervisor || {
      ready: false,
      required: [],
      issues: []
    },
    services: {
      relay: services.relay || null,
      registryAgent: services.registryAgent || null,
      webrtc: services.webrtc || null
    },
    issues: Array.isArray(report.issues) ? report.issues : [],
    nextSteps: Array.isArray(report.nextSteps) ? report.nextSteps : []
  };
}

function runNodeSupervisorService(rawArgs = [], deps = {}) {
  const options = parseNodeSupervisorServiceArgs(rawArgs, deps);
  if (options.action === 'install') {
    return runNodeSupervisorServiceInstall(options, deps);
  }
  if (options.action === 'uninstall') {
    return runNodeSupervisorServiceUninstall(options, deps);
  }
  const report = buildNodeDoctorReport(options, deps);
  const status = buildNodeSupervisorServiceStatus(report);
  return {
    ok: status.ok,
    json: Boolean(options.json),
    action: options.action,
    nodeId: status.node && status.node.id || nonEmptyString(options.nodeId),
    status
  };
}

function quoteCliArg(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function formatCliCommand(args) {
  return args.map((arg) => quoteCliArg(arg)).join(' ');
}

function appendValueArg(args, flag, value) {
  const text = nonEmptyString(value);
  if (text) args.push(flag, text);
}

function buildRelayInstallArgs(options) {
  const args = ['install', options.controlUrl, '--node-id', options.nodeId];
  appendValueArg(args, '--heartbeat-ms', options.relay && options.relay.heartbeatMs);
  appendValueArg(args, '--connect-timeout-ms', options.relay && options.relay.connectTimeoutMs);
  appendValueArg(args, '--reconnect-delay-ms', options.relay && options.relay.reconnectDelayMs);
  return args;
}

function buildRegistryAgentInstallArgs(options) {
  const registryAgent = options.registryAgent || {};
  const args = [
    'install',
    options.controlUrl,
    '--node-id',
    options.nodeId,
    '--token-file',
    options.tokenFile
  ];
  appendValueArg(args, '--status', registryAgent.status);
  appendValueArg(args, '--relay-status', registryAgent.relayStatus);
  (Array.isArray(registryAgent.transports) ? registryAgent.transports : []).forEach((value) => {
    appendValueArg(args, '--transport', value);
  });
  (Array.isArray(registryAgent.probeTransports) ? registryAgent.probeTransports : []).forEach((value) => {
    appendValueArg(args, '--probe-transport', value);
  });
  appendValueArg(args, '--probe-timeout-ms', registryAgent.probeTimeoutMs);
  appendValueArg(args, '--probe-method', registryAgent.probeMethod);
  appendValueArg(args, '--probe-count', registryAgent.probeCount);
  appendValueArg(args, '--probe-payload-size', registryAgent.probePayloadSize);
  appendValueArg(args, '--interval-ms', registryAgent.intervalMs);
  args.push('--runtime-diagnostics');
  return args;
}

function buildWebrtcInstallArgs(options) {
  const args = ['install', options.controlUrl, '--node-id', options.nodeId];
  appendValueArg(args, '--connect-timeout-ms', options.webrtc && options.webrtc.connectTimeoutMs);
  appendValueArg(args, '--reconnect-delay-ms', options.webrtc && options.webrtc.reconnectDelayMs);
  return args;
}

function buildNodeSupervisorInstallPlan(options) {
  const relayArgs = buildRelayInstallArgs(options);
  const registryAgentArgs = buildRegistryAgentInstallArgs(options);
  const webrtcArgs = buildWebrtcInstallArgs(options);
  return {
    action: 'install',
    dryRun: Boolean(options.dryRun),
    writes: !options.dryRun,
    requiresConfirmation: !options.dryRun && !options.yes,
    services: [
      {
        key: 'relay',
        label: 'Relay service',
        command: formatCliCommand(['aih', 'node', 'relay', 'service', ...relayArgs]),
        args: relayArgs
      },
      {
        key: 'registryAgent',
        label: 'Fabric registry agent service',
        command: formatCliCommand(['aih', 'fabric', 'registry', 'agent', 'service', ...registryAgentArgs]),
        args: registryAgentArgs
      },
      {
        key: 'webrtc',
        label: 'WebRTC connector service',
        command: formatCliCommand(['aih', 'node', 'webrtc', 'service', ...webrtcArgs]),
        args: webrtcArgs
      }
    ]
  };
}

function buildRelayUninstallArgs(options) {
  return ['uninstall', '--node-id', options.nodeId];
}

function buildRegistryAgentUninstallArgs(options) {
  return ['uninstall', '--node-id', options.nodeId];
}

function buildWebrtcUninstallArgs(options) {
  return ['uninstall', '--node-id', options.nodeId];
}

function buildNodeSupervisorUninstallPlan(options) {
  const webrtcArgs = buildWebrtcUninstallArgs(options);
  const registryAgentArgs = buildRegistryAgentUninstallArgs(options);
  const relayArgs = buildRelayUninstallArgs(options);
  return {
    action: 'uninstall',
    dryRun: Boolean(options.dryRun),
    writes: !options.dryRun,
    requiresConfirmation: !options.dryRun && !options.yes,
    services: [
      {
        key: 'webrtc',
        label: 'WebRTC connector service',
        command: formatCliCommand(['aih', 'node', 'webrtc', 'service', ...webrtcArgs]),
        args: webrtcArgs
      },
      {
        key: 'registryAgent',
        label: 'Fabric registry agent service',
        command: formatCliCommand(['aih', 'fabric', 'registry', 'agent', 'service', ...registryAgentArgs]),
        args: registryAgentArgs
      },
      {
        key: 'relay',
        label: 'Relay service',
        command: formatCliCommand(['aih', 'node', 'relay', 'service', ...relayArgs]),
        args: relayArgs
      }
    ]
  };
}

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function assertCanInstallNodeSupervisorService(options, deps = {}) {
  if (!options.yes) {
    const error = new Error('node_service_install_confirmation_required');
    error.code = 'node_service_install_confirmation_required';
    throw error;
  }
  const serverConfig = readServerConfigSafe(deps.readServerConfig);
  if (!nonEmptyString(serverConfig.managementKey)) {
    const error = new Error('management_key_required');
    error.code = 'management_key_required';
    error.command = 'relay-service';
    throw error;
  }
  const fsImpl = deps.fs || fs;
  try {
    fsImpl.accessSync(options.tokenFile, fs.constants.R_OK);
  } catch (_error) {
    const error = new Error('fabric_token_file_unreadable');
    error.code = 'fabric_token_file_unreadable';
    error.file = options.tokenFile;
    throw error;
  }
}

function runNodeSupervisorServiceInstall(options, deps = {}) {
  const plan = buildNodeSupervisorInstallPlan(options);
  const statusBefore = buildNodeSupervisorServiceStatus(buildNodeDoctorReport(options, deps));

  if (options.dryRun) {
    return {
      ok: true,
      json: Boolean(options.json),
      action: options.action,
      nodeId: nonEmptyString(options.nodeId),
      dryRun: true,
      plan,
      status: statusBefore
    };
  }

  assertCanInstallNodeSupervisorService(options, deps);
  const relayPlan = plan.services.find((service) => service.key === 'relay');
  const registryAgentPlan = plan.services.find((service) => service.key === 'registryAgent');
  const webrtcPlan = plan.services.find((service) => service.key === 'webrtc');
  const relay = runNodeRelayService(relayPlan.args, deps);
  const registryAgent = runFabricRegistryAgentService(registryAgentPlan.args, deps);
  const webrtc = runNodeWebrtcService(webrtcPlan.args, deps);
  const status = buildNodeSupervisorServiceStatus(buildNodeDoctorReport(options, deps));
  return {
    ok: true,
    json: Boolean(options.json),
    action: options.action,
    nodeId: nonEmptyString(options.nodeId),
    dryRun: false,
    plan,
    result: {
      relay,
      registryAgent,
      webrtc
    },
    status
  };
}

function assertCanUninstallNodeSupervisorService(options) {
  if (options.yes) return;
  const error = new Error('node_service_uninstall_confirmation_required');
  error.code = 'node_service_uninstall_confirmation_required';
  throw error;
}

function runNodeSupervisorServiceUninstall(options, deps = {}) {
  const plan = buildNodeSupervisorUninstallPlan(options);
  const statusBefore = buildNodeSupervisorServiceStatus(buildNodeDoctorReport(options, deps));

  if (options.dryRun) {
    return {
      ok: true,
      json: Boolean(options.json),
      action: options.action,
      nodeId: nonEmptyString(options.nodeId),
      dryRun: true,
      plan,
      status: statusBefore
    };
  }

  assertCanUninstallNodeSupervisorService(options);
  const webrtcPlan = plan.services.find((service) => service.key === 'webrtc');
  const registryAgentPlan = plan.services.find((service) => service.key === 'registryAgent');
  const relayPlan = plan.services.find((service) => service.key === 'relay');
  const webrtc = runNodeWebrtcService(webrtcPlan.args, deps);
  const registryAgent = runFabricRegistryAgentService(registryAgentPlan.args, deps);
  const relay = runNodeRelayService(relayPlan.args, deps);
  const status = buildNodeSupervisorServiceStatus(buildNodeDoctorReport(options, deps));
  return {
    ok: true,
    json: Boolean(options.json),
    action: options.action,
    nodeId: nonEmptyString(options.nodeId),
    dryRun: false,
    plan,
    result: {
      webrtc,
      registryAgent,
      relay
    },
    status
  };
}

module.exports = {
  buildNodeSupervisorServiceStatus,
  buildNodeSupervisorInstallPlan,
  buildNodeSupervisorUninstallPlan,
  parseNodeSupervisorServiceArgs,
  runNodeSupervisorService
};
