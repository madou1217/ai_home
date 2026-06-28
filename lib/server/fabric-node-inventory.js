'use strict';

const DEFAULT_SESSION_PROVIDERS = Object.freeze(['codex', 'claude', 'agy', 'opencode']);
const ONLINE_STATUSES = new Set(['available', 'healthy', 'online', 'ready', 'up']);
const DEGRADED_STATUSES = new Set(['degraded', 'partial', 'pending', 'warning']);
const OFFLINE_STATUSES = new Set(['disabled', 'down', 'failed', 'offline', 'unhealthy']);

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringList(value, maxLength = 96) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)));
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value, fallback = 'unknown') {
  return normalizeText(value, 64).toLowerCase() || fallback;
}

function includesRole(node, role) {
  return normalizeStringList(node && node.roles, 64)
    .map((item) => item.toLowerCase())
    .includes(role);
}

function includesCapability(node, capability) {
  return normalizeStringList(node && node.capabilities, 96)
    .map((item) => item.toLowerCase())
    .includes(capability);
}

function isOnlineStatus(value) {
  return ONLINE_STATUSES.has(normalizeStatus(value));
}

function isDegradedStatus(value) {
  return DEGRADED_STATUSES.has(normalizeStatus(value));
}

function isOfflineStatus(value) {
  return OFFLINE_STATUSES.has(normalizeStatus(value));
}

function hasMeasurement(transport) {
  const measurement = normalizeObject(transport && transport.measurement);
  return Boolean(
    normalizeText(measurement.status, 96)
      || Number(measurement.durationMs) > 0
      || Number(measurement.sampleCount) > 0
      || Number(measurement.measuredAt) > 0
      || normalizeObject(measurement.rttMs).count !== undefined
  );
}

function summarizeTransportState(transports) {
  const items = normalizeArray(transports);
  if (items.length === 0) return 'missing';
  if (items.some((transport) => isOnlineStatus(transport && transport.health))) return 'online';
  if (items.some((transport) => isDegradedStatus(transport && transport.health))) return 'degraded';
  if (items.every((transport) => isOfflineStatus(transport && transport.health))) return 'offline';
  return 'unknown';
}

function summarizeRelayState(relayNode, transports) {
  if (!relayNode) return 'missing';
  if (relayNode.enabled === false) return 'disabled';
  const transportState = summarizeTransportState(transports);
  if (transportState !== 'missing' && transportState !== 'unknown') return transportState;
  return normalizeStatus(relayNode.status);
}

function buildAction(id, label, enabled, blockers = [], extra = {}) {
  const normalizedBlockers = normalizeStringList(blockers, 128);
  return {
    id,
    label,
    enabled: Boolean(enabled) && normalizedBlockers.length === 0,
    blockers: normalizedBlockers,
    ...extra
  };
}

function buildStartSessionAction(provider, view) {
  const hasProjects = view.projects.length > 0;
  const runtime = view.runtimes.find((item) => normalizeStatus(item && item.provider, '') === provider) || null;
  const runtimeStatus = normalizeStatus(runtime && runtime.status, runtime ? 'available' : 'missing');
  const runtimeReady = Boolean(runtime) && !isOfflineStatus(runtimeStatus);
  const hasTransport = view.transports.length > 0;
  const blockers = [];
  if (!hasProjects) blockers.push('missing_project_snapshot');
  if (!runtime) blockers.push(`missing_provider_runtime:${provider}`);
  else if (!runtimeReady) blockers.push(`provider_runtime_not_ready:${provider}:${runtimeStatus}`);
  if (!hasTransport) blockers.push('missing_transport');
  blockers.push('m4_remote_session_action_pending');
  return buildAction(`start-session:${provider}`, `Start ${provider}`, false, blockers, {
    provider,
    eligible: hasProjects && runtimeReady && hasTransport,
    runtimeId: runtime ? normalizeText(runtime.id, 96) : '',
    runtimeStatus
  });
}

function buildNodeCapabilities(view) {
  const node = view.node;
  const relayTransports = view.transports.filter((transport) => normalizeStatus(transport && transport.kind, '') === 'relay');
  const sshTransports = view.transports.filter((transport) => normalizeStatus(transport && transport.kind, '') === 'ssh');
  const transportKinds = Array.from(new Set(view.transports
    .map((transport) => normalizeStatus(transport && transport.kind, ''))
    .filter(Boolean)))
    .sort();
  const runtimeProviders = Array.from(new Set(view.runtimes
    .map((runtime) => normalizeStatus(runtime && runtime.provider, ''))
    .filter(Boolean)))
    .sort();
  const measuredTransports = view.transports.filter(hasMeasurement);
  const projectHost = view.projects.length > 0 || includesCapability(node, 'projects');
  const runtimeHost = runtimeProviders.length > 0 || includesCapability(node, 'runtimes') || includesCapability(node, 'sessions');
  const relayNode = Boolean(view.relayNode) || includesRole(node, 'relay-node');
  const sshBootstrap = sshTransports.length > 0 || includesCapability(node, 'ssh-bootstrap') || includesCapability(node, 'ssh');
  return {
    server: includesRole(node, 'server'),
    node: includesRole(node, 'node'),
    relayNode,
    projectHost,
    runtimeHost,
    sshBootstrap,
    measured: measuredTransports.length > 0,
    transportKinds,
    runtimeProviders,
    relayState: summarizeRelayState(view.relayNode, relayTransports),
    transportState: summarizeTransportState(view.transports)
  };
}

function buildNodeActions(view, sessionProviders = DEFAULT_SESSION_PROVIDERS) {
  const actions = [];
  actions.push(buildAction(
    'open-project',
    'Open project',
    false,
    [
      ...(view.projects.length > 0 ? [] : ['missing_project_snapshot']),
      'm4_project_action_pending'
    ],
    {
      eligible: view.projects.length > 0
    }
  ));
  for (const provider of sessionProviders) {
    actions.push(buildStartSessionAction(provider, view));
  }
  actions.push(buildAction(
    'configure-ssh',
    'Configure SSH',
    view.capabilities && view.capabilities.sshBootstrap,
    view.capabilities && view.capabilities.sshBootstrap ? [] : ['missing_ssh_bootstrap_transport'],
    {
      eligible: Boolean(view.capabilities && view.capabilities.sshBootstrap)
    }
  ));
  actions.push(buildAction(
    'run-measurement',
    'Run measurement',
    view.transports.length > 0,
    view.transports.length > 0 ? [] : ['missing_transport'],
    {
      eligible: view.transports.length > 0
    }
  ));
  actions.push(buildAction(
    'enable-relay',
    'Enable relay',
    false,
    view.relayNode ? ['relay_already_registered'] : ['relay_role_enable_flow_pending'],
    {
      eligible: !view.relayNode
    }
  ));
  return actions;
}

function buildFabricNodeInventory(registry = {}, options = {}) {
  const source = normalizeObject(registry);
  const nodes = normalizeArray(source.nodes);
  const relayNodes = normalizeArray(source.relayNodes);
  const transports = normalizeArray(source.transports);
  const projects = normalizeArray(source.projects);
  const runtimes = normalizeArray(source.runtimes);
  const networkMeasurements = normalizeArray(source.networkMeasurements);
  const sessionProviders = normalizeStringList(options.sessionProviders, 64);
  const providers = sessionProviders.length > 0 ? sessionProviders : DEFAULT_SESSION_PROVIDERS;

  return nodes.map((node) => {
    const nodeId = normalizeText(node && node.id, 96);
    const relayNode = relayNodes.find((item) => normalizeText(item && item.nodeId, 96) === nodeId) || null;
    const nodeTransports = transports.filter((item) => normalizeText(item && item.nodeId, 96) === nodeId);
    const nodeProjects = projects.filter((item) => normalizeText(item && item.nodeId, 96) === nodeId);
    const nodeRuntimes = runtimes.filter((item) => normalizeText(item && item.nodeId, 96) === nodeId);
    const measurements = networkMeasurements.filter((item) => normalizeText(item && item.nodeId, 96) === nodeId);
    const view = {
      id: nodeId,
      name: normalizeText(node && node.name, 120) || nodeId,
      node,
      relayNode,
      projects: nodeProjects,
      runtimes: nodeRuntimes,
      transports: nodeTransports,
      networkMeasurements: measurements
    };
    const capabilities = buildNodeCapabilities(view);
    const withCapabilities = {
      ...view,
      capabilities
    };
    return {
      ...withCapabilities,
      actions: buildNodeActions(withCapabilities, providers)
    };
  });
}

module.exports = {
  DEFAULT_SESSION_PROVIDERS,
  buildFabricNodeInventory
};
