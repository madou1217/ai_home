'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildFabricNodeInventory } = require('../../../server/fabric-node-inventory');
const {
  DEFAULT_TIMEOUT_MS,
  buildProfileSummary,
  createError,
  fetchJson,
  loadControlPlaneProfileStore,
  normalizeHttpEndpoint,
  normalizeOptionalHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath,
  selectReadyProfile
} = require('./server-profile-client');
const {
  enrichNodeInventoryWithLocalSsh,
  loadLocalSshInventory
} = require('./local-ssh-node-bindings');

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    nodeId: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: ''
  };

  for (let index = 0; index < argv.length;) {
    const token = normalizeText(argv[index], 256);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--ai-home-dir' || token.startsWith('--ai-home-dir=')) {
      const next = readOptionValue(argv, index, '--ai-home-dir');
      options.aiHomeDir = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--profile-id' || token.startsWith('--profile-id=')) {
      const next = readOptionValue(argv, index, '--profile-id');
      options.profileId = normalizeText(next.value, 96);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = normalizeText(next.value, 128);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (!isFlag(token) && !options.nodeId) {
      options.nodeId = normalizeText(token, 128);
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  return options;
}

function buildRegistryUrl(endpoint) {
  return new URL('/v0/fabric/registry', normalizeHttpEndpoint(endpoint)).toString();
}

function normalizeCounts(source = {}, registry = {}) {
  return {
    nodes: Number(source.nodes || normalizeArray(registry.nodes).length || 0),
    relayNodes: Number(source.relayNodes || normalizeArray(registry.relayNodes).length || 0),
    transports: Number(source.transports || normalizeArray(registry.transports).length || 0),
    projects: Number(source.projects || normalizeArray(registry.projects).length || 0),
    runtimes: Number(source.runtimes || normalizeArray(registry.runtimes).length || 0)
  };
}

function normalizeRegistryResult(payload = {}) {
  const source = normalizeObject(payload && payload.result);
  const registry = {
    version: Number(source.version || 0),
    nodes: normalizeArray(source.nodes),
    relayNodes: normalizeArray(source.relayNodes),
    transports: normalizeArray(source.transports),
    projects: normalizeArray(source.projects),
    runtimes: normalizeArray(source.runtimes),
    runtimeDiagnostics: normalizeArray(source.runtimeDiagnostics),
    networkMeasurements: normalizeArray(source.networkMeasurements)
  };
  registry.counts = normalizeCounts(normalizeObject(source.counts), registry);
  registry.nodeInventory = Array.isArray(source.nodeInventory)
    ? source.nodeInventory
    : buildFabricNodeInventory(registry);
  return registry;
}

function applyLocalSshInventory(registry, options = {}, deps = {}) {
  const localSsh = loadLocalSshInventory({ aiHomeDir: options.aiHomeDir }, deps);
  return {
    ...registry,
    nodeInventory: enrichNodeInventoryWithLocalSsh(registry.nodeInventory, localSsh)
  };
}

function summarizeAction(action = {}) {
  return {
    id: normalizeText(action.id, 160),
    label: normalizeText(action.label, 120),
    enabled: action.enabled === true,
    eligible: action.eligible === true,
    blockers: normalizeArray(action.blockers).map((item) => normalizeText(item, 160)).filter(Boolean),
    provider: normalizeText(action.provider, 64),
    runtimeId: normalizeText(action.runtimeId, 96),
    runtimeStatus: normalizeText(action.runtimeStatus, 64)
  };
}

function summarizeNode(node = {}) {
  const capabilities = normalizeObject(node.capabilities);
  const projects = normalizeArray(node.projects);
  const runtimes = normalizeArray(node.runtimes);
  const runtimeDiagnostics = normalizeArray(node.runtimeDiagnostics);
  const transports = normalizeArray(node.transports);
  return {
    id: normalizeText(node.id, 96),
    name: normalizeText(node.name, 120),
    status: normalizeText(node.node && node.node.status, 32),
    roles: normalizeArray(node.node && node.node.roles).map((item) => normalizeText(item, 64)).filter(Boolean),
    counts: {
      projects: projects.length,
      runtimes: runtimes.length,
      runtimeDiagnostics: runtimeDiagnostics.length,
      transports: transports.length,
      measurements: normalizeArray(node.networkMeasurements).length
    },
    capabilities: {
      server: capabilities.server === true,
      node: capabilities.node === true,
      relayNode: capabilities.relayNode === true,
      projectHost: capabilities.projectHost === true,
      runtimeHost: capabilities.runtimeHost === true,
      sshBootstrap: capabilities.sshBootstrap === true,
      measured: capabilities.measured === true,
      transportKinds: normalizeArray(capabilities.transportKinds).map((item) => normalizeText(item, 64)).filter(Boolean),
      runtimeProviders: normalizeArray(capabilities.runtimeProviders).map((item) => normalizeText(item, 64)).filter(Boolean),
      relayState: normalizeText(capabilities.relayState, 64),
      transportState: normalizeText(capabilities.transportState, 64)
    },
    projects: projects.map((project) => ({
      id: normalizeText(project && project.id, 96),
      name: normalizeText(project && project.name, 120),
      displayPath: normalizeText(project && project.displayPath, 2048)
    })),
    runtimes: runtimes.map((runtime) => ({
      id: normalizeText(runtime && runtime.id, 96),
      provider: normalizeText(runtime && runtime.provider, 64),
      mode: normalizeText(runtime && runtime.mode, 64),
      status: normalizeText(runtime && runtime.status, 64),
      version: normalizeText(runtime && runtime.version, 120)
    })),
    transports: transports.map((transport) => {
      const measurement = normalizeObject(transport && transport.measurement);
      return {
        id: normalizeText(transport && transport.id, 96),
        kind: normalizeText(transport && transport.kind, 64),
        health: normalizeText(transport && (transport.health || transport.status), 64),
        routeRole: normalizeText(transport && transport.routeRole, 64),
        trustLevel: normalizeText(transport && transport.trustLevel, 64),
        measurement: Object.keys(measurement).length > 0 ? {
          status: normalizeText(measurement.status, 96),
          sampleCount: Number(measurement.sampleCount || measurement.successes || 0),
          successRate: measurement.successRate === undefined ? null : Number(measurement.successRate),
          failures: Number(measurement.failures || 0),
          rttMs: measurement.rttMs && typeof measurement.rttMs === 'object' ? measurement.rttMs : null
        } : null
      };
    }),
    runtimeGaps: normalizeArray(node.runtimeGaps).map((gap) => ({
      provider: normalizeText(gap && gap.provider, 64),
      status: normalizeText(gap && gap.status, 64),
      blocker: normalizeText(gap && gap.blocker, 160),
      diagnostic: normalizeObject(gap && gap.diagnostic),
      runtimeId: normalizeText(gap && gap.runtimeId, 96)
    })),
    actions: normalizeArray(node.actions).map(summarizeAction),
    localSshBindings: normalizeArray(node.localSshBindings).map((binding) => ({
      source: normalizeText(binding && binding.source, 64),
      connectionId: normalizeText(binding && binding.connectionId, 96),
      connectionLabel: normalizeText(binding && binding.connectionLabel, 120),
      workspaceId: normalizeText(binding && binding.workspaceId, 96),
      workspaceLabel: normalizeText(binding && binding.workspaceLabel, 120),
      host: normalizeText(binding && binding.host, 255),
      port: Number(binding && binding.port || 0) || 22,
      user: normalizeText(binding && binding.user, 96),
      authType: normalizeText(binding && binding.authType, 48),
      target: normalizeText(binding && binding.target, 255),
      remoteRoot: normalizeText(binding && binding.remoteRoot, 2048),
      projectId: normalizeText(binding && binding.projectId, 96),
      projectName: normalizeText(binding && binding.projectName, 120)
    }))
  };
}

function findTargetNode(nodes, nodeId) {
  const wanted = normalizeText(nodeId, 128);
  if (!wanted) return nodes[0] || null;
  return nodes.find((node) => node.id === wanted) || null;
}

function buildSummary(nodes, targetNode) {
  return {
    nodes: nodes.length,
    runtimeHostNodes: nodes.filter((node) => node.capabilities.runtimeHost).length,
    relayNodes: nodes.filter((node) => node.capabilities.relayNode).length,
    projectHosts: nodes.filter((node) => node.capabilities.projectHost).length,
    sshBootstrapNodes: nodes.filter((node) => node.capabilities.sshBootstrap).length,
    measuredNodes: nodes.filter((node) => node.capabilities.measured).length,
    targetNodeId: targetNode ? targetNode.id : '',
    targetRuntimeHost: Boolean(targetNode && targetNode.capabilities.runtimeHost),
    targetRuntimeProviders: targetNode ? targetNode.capabilities.runtimeProviders : [],
    targetRuntimeGaps: targetNode ? targetNode.runtimeGaps : []
  };
}

function evaluateNodesReport(profile, registry, unauth, authorized, options = {}) {
  const nodes = normalizeArray(registry.nodeInventory).map(summarizeNode);
  const targetNode = findTargetNode(nodes, options.nodeId);
  const checks = {
    unauthRejected: unauth.status === 401,
    authorizedRead: authorized.status === 200 && authorized.ok === true,
    rpcOk: authorized.body && authorized.body.ok === true && authorized.body.rpc === 'fabric.registry.read',
    nodeFound: !normalizeText(options.nodeId, 128) || Boolean(targetNode)
  };
  const blockers = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  const registryUrl = buildRegistryUrl(profile.endpoint);
  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      nodeId: normalizeText(options.nodeId, 128),
      registryUrl
    },
    http: {
      unauthenticatedStatus: unauth.status,
      authorizedStatus: authorized.status
    },
    checks,
    registry: {
      counts: registry.counts
    },
    summary: buildSummary(nodes, targetNode),
    targetNode,
    nodes,
    blockers
  };
}

async function runFabricNodesClient(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    nodeId: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const registryUrl = buildRegistryUrl(profile.endpoint);
  const unauth = await fetchJson(registryUrl, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_nodes_request_timeout',
    headers: { accept: 'application/json' }
  }, deps);
  const authorized = await fetchJson(registryUrl, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_nodes_request_timeout',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${profile.deviceToken}`
    }
  }, deps);
  const registry = applyLocalSshInventory(normalizeRegistryResult(authorized.body), options, deps);
  const report = evaluateNodesReport(profile, registry, unauth, authorized, options);
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runFabricNodesClientCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricNodesClient(options, deps);
  return {
    ...report,
    json: options.json === true
  };
}

function writeDiagnosticsFile(filePath, report) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function resolveDiagnosticAvailableAccounts(accounts) {
  if (Object.prototype.hasOwnProperty.call(accounts, 'available')) {
    return Number(accounts.available) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(accounts, 'schedulable')) {
    return Number(accounts.schedulable) || 0;
  }
  return null;
}

function formatRuntimeGapDiagnostic(diagnostic = {}) {
  const source = normalizeObject(diagnostic);
  const cli = normalizeObject(source.cli);
  const accounts = normalizeObject(source.accounts);
  const parts = [];
  if (Object.prototype.hasOwnProperty.call(cli, 'available')) {
    parts.push(`cli=${yesNo(cli.available === true)}`);
  }
  const total = Object.prototype.hasOwnProperty.call(accounts, 'total')
    ? Number(accounts.total) || 0
    : null;
  const available = resolveDiagnosticAvailableAccounts(accounts);
  if (total !== null) {
    parts.push(`account_total=${total}`);
  }
  if (available !== null) {
    parts.push(`account_available=${available}`);
  }
  if (Object.prototype.hasOwnProperty.call(accounts, 'unavailable')) {
    parts.push(`account_unavailable=${Number(accounts.unavailable) || 0}`);
  } else if (total !== null && available !== null) {
    parts.push(`account_unavailable=${Math.max(0, total - available)}`);
  }
  const accountSource = normalizeText(accounts.source, 64);
  if (accountSource) {
    parts.push(`account_source=${accountSource}`);
  }
  const cliError = normalizeText(cli.error, 160);
  if (cliError) {
    parts.push(`cli_error=${cliError}`);
  }
  const accountError = normalizeText(accounts.error, 160);
  if (accountError) {
    parts.push(`account_error=${accountError}`);
  }
  const reasons = normalizeArray(accounts.reasons)
    .map((item) => {
      const reason = normalizeText(item && item.reason, 160).replace(/\s+/g, '_');
      if (!reason) return '';
      const count = Number(item && item.count) || 0;
      return `${reason}=${count}`;
    })
    .filter(Boolean)
    .slice(0, 3);
  if (reasons.length > 0) {
    parts.push(`account_reasons=${reasons.join(',')}`);
  }
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}

function formatNodeReport(node) {
  if (!node) return ['  node: not found'];
  const lines = [
    `  node: ${node.name || node.id} (${node.id})`,
    `  roles: ${node.roles.join(', ') || 'none'}`,
    `  capabilities: server=${yesNo(node.capabilities.server)} relay=${yesNo(node.capabilities.relayNode)} project_host=${yesNo(node.capabilities.projectHost)} runtime_host=${yesNo(node.capabilities.runtimeHost)} ssh=${yesNo(node.capabilities.sshBootstrap)} measured=${yesNo(node.capabilities.measured)}`,
    `  transports: ${node.capabilities.transportKinds.join(', ') || 'none'} (${node.capabilities.transportState || 'unknown'})`,
    `  runtimes: ${node.capabilities.runtimeProviders.join(', ') || 'none'}`
  ];
  if (node.runtimeGaps.length > 0) {
    lines.push('  runtime_gaps:');
    node.runtimeGaps.forEach((gap) => {
      const diagnostic = formatRuntimeGapDiagnostic(gap.diagnostic);
      lines.push(`    - ${gap.provider}: ${gap.blocker || gap.status || 'unknown'}${diagnostic}`);
    });
  }
  if (node.localSshBindings.length > 0) {
    lines.push('  ssh_links:');
    node.localSshBindings.forEach((binding) => {
      const label = binding.connectionLabel || binding.workspaceLabel || binding.target || binding.host;
      const workspace = binding.workspaceLabel ? ` -> ${binding.workspaceLabel}` : '';
      const target = binding.target || binding.host;
      const port = binding.port && binding.port !== 22 ? `:${binding.port}` : '';
      lines.push(`    - ${label}${workspace} (${target}${port}:${binding.remoteRoot})`);
    });
  }
  const actions = node.actions.filter((action) => action.id === 'open-project' || action.id.startsWith('start-session:') || action.id === 'configure-ssh');
  if (actions.length > 0) {
    lines.push('  actions:');
    actions.forEach((action) => {
      const state = action.enabled ? 'enabled' : (action.eligible ? 'pending' : 'blocked');
      const blockers = action.blockers.length > 0 ? ` (${action.blockers.join(', ')})` : '';
      lines.push(`    - ${action.id}: ${state}${blockers}`);
    });
  }
  return lines;
}

function formatReport(report = {}) {
  const counts = report.registry && report.registry.counts ? report.registry.counts : {};
  const lines = [
    'AIH Fabric nodes',
    `  profile: ${report.profile && report.profile.name || ''} (${report.profile && report.profile.id || ''})`,
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  http: unauth=${report.http && report.http.unauthenticatedStatus || 0} auth=${report.http && report.http.authorizedStatus || 0}`,
    `  registry: nodes=${counts.nodes || 0} relay_nodes=${counts.relayNodes || 0} projects=${counts.projects || 0} runtimes=${counts.runtimes || 0} transports=${counts.transports || 0}`
  ];
  formatNodeReport(report.targetNode).forEach((line) => lines.push(line));
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  if (blockers.length) {
    lines.push('  blockers:');
    blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  lines.push(`  result: ${report.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

module.exports = {
  buildRegistryUrl,
  evaluateNodesReport,
  formatFabricNodesClientReport: formatReport,
  formatReport,
  applyLocalSshInventory,
  normalizeRegistryResult,
  parseArgs,
  parseFabricNodesClientArgs: parseArgs,
  runFabricNodesClient,
  runFabricNodesClientCommand,
  summarizeNode
};
