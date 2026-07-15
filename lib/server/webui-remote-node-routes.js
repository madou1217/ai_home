'use strict';

const { getRemoteNode, upsertRemoteNode, normalizeId } = require('./remote/node-registry');
const {
  getTransportKindMetadata,
  normalizeTransportKind,
  listNodeTransports,
  upsertRemoteTransport
} = require('./remote/transport-registry');
const { listRemoteNodeViews, serializeRemoteNodeForView } = require('./remote/remote-node-view');
const { writeRemoteSecret } = require('./remote/secret-store');
const { requestRemoteManagement } = require('./remote/remote-gateway');
const {
  DEFAULT_REMOTE_TRANSPORT_KIND,
  buildRemoteNodeDefaults,
  resolveTransportProvider,
  resolveTransportRouteRole,
  resolveTransportTrustLevel
} = require('./remote/node-defaults');
const {
  createRemoteNodeInvite,
  listRemoteNodeInvites
} = require('./remote/worker-join-invite');
const { buildRemoteBootstrapProbeView } = require('./remote/bootstrap-probe-view');
const {
  appendSearch,
  matchRemoteManagementRoute,
  nodeSupportsCapability
} = require('./remote/remote-management-routes');
const {
  SUPPORTED_BOOTSTRAP_TARGETS,
  formatNodeJoinCommand,
  buildNodeBootstrapPlan
} = require('../cli/services/node/bootstrap');
const { getLoopbackControlEndpointWarning } = require('../control-endpoint');
const {
  DEFAULT_TCP_PORTS,
  buildNodeBootstrapProbeCommand,
  buildNodeBootstrapProbeOptionArgs,
  runNodeBootstrapProbe
} = require('../cli/services/node/bootstrap-probe');
const {
  buildNodeBootstrapApplyCommand,
  buildNodeBootstrapApplyPreview,
  runNodeBootstrapApply
} = require('../cli/services/node/bootstrap-apply');

const REMOTE_INVITE_LOOPBACK_WARNING = 'Control Endpoint 指向 localhost/127.0.0.1；远端机器会把它当成自己本机。请改用局域网、Tailscale/ZeroTier/WireGuard、FRP/SSH tunnel 或公网入口后重新生成。';

async function readJsonPayload(ctx) {
  const body = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return null;
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function remoteDeps(ctx) {
  return {
    fs: ctx.fs,
    aiHomeDir: ctx.aiHomeDir,
    hostname: ctx.deps && ctx.deps.hostname,
    processObj: ctx.deps && ctx.deps.processObj,
    platform: ctx.deps && ctx.deps.platform,
    arch: ctx.deps && ctx.deps.arch,
    fetchImpl: ctx.deps && ctx.deps.fetchImpl,
    relaySessionRegistry: ctx.deps && ctx.deps.relaySessionRegistry,
    requestRelayManagement: ctx.deps && ctx.deps.requestRelayManagement,
    requestRelayManagementStream: ctx.deps && ctx.deps.requestRelayManagementStream,
    webrtcSessionRegistry: ctx.deps && ctx.deps.webrtcSessionRegistry,
    requestWebrtcManagement: ctx.deps && ctx.deps.requestWebrtcManagement,
    hasWebrtcManagementSession: ctx.deps && ctx.deps.hasWebrtcManagementSession,
    sshProbe: ctx.deps && ctx.deps.sshProbe,
    tcpProbe: ctx.deps && ctx.deps.tcpProbe,
    httpProbe: ctx.deps && ctx.deps.httpProbe,
    commandRunner: ctx.deps && ctx.deps.commandRunner,
    spawnImpl: ctx.deps && ctx.deps.spawnImpl,
    spawnSync: ctx.deps && ctx.deps.spawnSync,
    gitRemoteUrl: ctx.deps && ctx.deps.gitRemoteUrl,
    homeDir: ctx.deps && ctx.deps.homeDir,
    cwd: ctx.deps && ctx.deps.cwd
  };
}

function serializeNode(node, transports = []) {
  return serializeRemoteNodeForView(node, transports, {
    includeAuthRef: true,
    includeTransportEndpoint: true,
    includeTransportSetupHint: true
  });
}

function hasInlineEndpoint(payload) {
  return Boolean(payload && (payload.endpoint || payload.baseUrl || payload.managementUrl));
}

function resolveInlineTransportKind(payload) {
  const explicitKind = String(payload && (payload.transportKind || payload.kind) || '').trim();
  return explicitKind || (hasInlineEndpoint(payload) ? 'direct' : DEFAULT_REMOTE_TRANSPORT_KIND);
}

function buildInlineTransport(node, payload) {
  const kind = normalizeTransportKind(resolveInlineTransportKind(payload)) || DEFAULT_REMOTE_TRANSPORT_KIND;
  const metadata = getTransportKindMetadata(kind) || {};
  const endpointMode = String(metadata.endpointMode || '').trim();
  const endpoint = String(
    payload && (payload.endpoint || payload.baseUrl || payload.managementUrl)
      || (kind === 'relay' ? `relay://${node.id}` : '')
  ).trim();
  const allowsEmptyEndpoint = endpointMode === 'manual' || endpointMode === 'none';
  if (!endpoint && !allowsEmptyEndpoint) return null;
  return {
    id: `${node.id}-${kind}`,
    nodeId: node.id,
    kind,
    endpoint,
    status: 'unknown',
    score: 50,
    managedBy: String(payload.managedBy || 'user').trim() || 'user',
    provider: String(payload.provider || payload.transportProvider || resolveTransportProvider(kind)).trim(),
    routeRole: String(payload.routeRole || resolveTransportRouteRole(kind)).trim() || 'data-plane',
    trustLevel: String(payload.trustLevel || resolveTransportTrustLevel(kind)).trim() || 'manual',
    setupHint: String(payload.setupHint || '').trim()
  };
}

function normalizePreferredTransports(value, fallback) {
  const input = Array.isArray(value) ? value : fallback;
  const transports = Array.from(new Set((Array.isArray(input) ? input : [])
    .map((item) => normalizeTransportKind(item))
    .filter(Boolean)));
  return transports.length > 0 ? transports : [DEFAULT_REMOTE_TRANSPORT_KIND];
}

function applyRemoteNodeSaveDefaults(payload, deps) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rawNodeId = String(source.id || source.nodeId || '').trim();
  if (rawNodeId && !normalizeId(rawNodeId)) {
    return source;
  }

  const transportKind = String(source.transportKind || source.kind || resolveInlineTransportKind(source)).trim();
  const invalidExplicitTransport = Boolean(
    String(source.transportKind || source.kind || '').trim()
      && !normalizeTransportKind(source.transportKind || source.kind)
  );
  const defaults = buildRemoteNodeDefaults({
    ...source,
    transportKind
  }, deps);
  return {
    ...source,
    id: rawNodeId || defaults.nodeId,
    name: String(source.name || defaults.name || defaults.nodeId).trim(),
    transportKind: defaults.transportKind,
    provider: String(invalidExplicitTransport ? defaults.provider : (source.provider || defaults.provider)).trim(),
    routeRole: String(invalidExplicitTransport ? defaults.routeRole : (source.routeRole || defaults.routeRole)).trim(),
    trustLevel: String(invalidExplicitTransport ? defaults.trustLevel : (source.trustLevel || defaults.trustLevel)).trim(),
    preferredTransports: normalizePreferredTransports(source.preferredTransports, defaults.preferredTransports)
  };
}

function inferControlEndpoint(ctx) {
  const headers = ctx.req && ctx.req.headers ? ctx.req.headers : {};
  const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  if (!host) {
    return ctx.url && ctx.url.origin ? String(ctx.url.origin).replace(/\/+$/, '') : '';
  }
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  return `${proto}://${host}`;
}

function buildNodeRpcStatusPath(ctx, nodeId, options = {}) {
  const params = new URLSearchParams();
  if (options.diagnostics) params.set('diagnostics', '1');
  const controlUrl = inferControlEndpoint(ctx);
  if (controlUrl) params.set('controlUrl', controlUrl);
  if (nodeId) params.set('nodeId', nodeId);
  const query = params.toString();
  return query ? `/v0/node-rpc/status?${query}` : '/v0/node-rpc/status';
}

function buildInvitePayload(ctx, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    ...source,
    controlEndpoint: source.controlEndpoint || inferControlEndpoint(ctx)
  };
}

function uniqueWarnings(values = []) {
  const warnings = [];
  values.forEach((value) => {
    const warning = String(value || '').trim();
    if (warning && !warnings.includes(warning)) warnings.push(warning);
  });
  return warnings;
}

function buildInviteWarnings(result) {
  const invite = result && result.invite ? result.invite : {};
  return uniqueWarnings([
    getLoopbackControlEndpointWarning(invite.controlEndpoint, REMOTE_INVITE_LOOPBACK_WARNING)
  ]);
}

function resolveBootstrapTarget(value) {
  const target = String(value || 'linux').trim().toLowerCase();
  if (SUPPORTED_BOOTSTRAP_TARGETS.includes(target)) return target;
  const error = new Error(`unsupported_bootstrap_target:${target || 'unknown'}`);
  error.code = 'unsupported_bootstrap_target';
  throw error;
}

function buildInviteBootstrap(result, payload) {
  const invite = result && result.invite ? result.invite : {};
  const source = payload && typeof payload === 'object' ? payload : {};
  const plan = buildNodeBootstrapPlan({
    target: resolveBootstrapTarget(source.bootstrapTarget),
    controlUrl: invite.controlEndpoint,
    inviteUrl: result && result.joinUrl,
    endpoint: invite.transportKind === 'relay' ? '' : invite.endpointHint,
    nodeId: invite.nodeId,
    repoUrl: source.repoUrl,
    repoDir: source.repoDir,
    repoSubdir: source.repoSubdir,
    transportKind: invite.transportKind
  });
  return {
    plan,
    script: plan.script
  };
}

function buildBootstrapPlanPayload(ctx, payload) {
  const source = buildInvitePayload(ctx, payload);
  const transportKind = String(source.transportKind || 'relay').trim() || 'relay';
  const endpoint = transportKind === 'relay'
    ? ''
    : String(source.endpoint || source.endpointHint || '').trim();
  const plan = buildNodeBootstrapPlan({
    target: resolveBootstrapTarget(source.bootstrapTarget),
    channel: source.bootstrapChannel || source.channel,
    controlUrl: source.controlEndpoint,
    inviteUrl: source.inviteUrl || source.joinUrl,
    endpoint,
    nodeId: source.nodeId || source.id,
    repoUrl: source.repoUrl,
    repoDir: source.repoDir,
    repoSubdir: source.repoSubdir,
    transportKind,
    installService: source.installService !== false
  }, remoteDeps(ctx));
  return {
    ok: true,
    plan,
    script: plan.script
  };
}

function normalizeProbeTargetList(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value || '');
  return Array.from(new Set(source
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .split(/[\s,]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function normalizeProbeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeProbePorts(value) {
  const ports = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const normalized = ports
    .map((item) => Number(String(item || '').trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return Array.from(new Set(normalized.length ? normalized : DEFAULT_TCP_PORTS)).sort((left, right) => left - right);
}

function buildBootstrapProbeOptions(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sshTargets = normalizeProbeTargetList(source.probeSshTargets || source.sshTargets);
  const tcpTargets = normalizeProbeTargetList(source.probeTcpTargets || source.tcpTargets);
  const httpTargets = normalizeProbeTargetList(source.probeHttpTargets || source.httpTargets || source.ingressTargets);
  if (sshTargets.length === 0 && tcpTargets.length === 0 && httpTargets.length === 0) {
    const error = new Error('missing_probe_targets');
    error.code = 'missing_probe_targets';
    throw error;
  }
  return {
    sshTargets,
    tcpTargets,
    httpTargets,
    ports: normalizeProbePorts(source.probeTcpPorts || source.ports),
    controlUrl: String(source.controlEndpoint || source.controlUrl || '').trim(),
    inviteUrl: String(source.inviteUrl || source.joinUrl || '').trim(),
    repoUrl: String(source.repoUrl || '').trim(),
    repoDir: String(source.repoDir || '').trim(),
    repoSubdir: String(source.repoSubdir || '').trim(),
    nodeId: String(source.nodeId || source.id || '').trim(),
    bootstrapTarget: String(source.bootstrapTarget || source.target || '').trim(),
    transportKind: String(source.transportKind || 'relay').trim() || 'relay',
    endpoint: String(source.endpoint || source.endpointHint || '').trim(),
    concurrency: normalizeProbeNumber(source.concurrency, 3, 1, 32),
    timeoutMs: normalizeProbeNumber(source.timeoutMs, 3000, 250, 120000),
    executeConcurrency: normalizeProbeNumber(source.executeConcurrency, 2, 1, 16),
    executeTimeoutMs: normalizeProbeNumber(source.executeTimeoutMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
  };
}

function buildBootstrapApplyArgs(options) {
  return [
    '--execute',
    '--yes',
    '--execute-concurrency',
    String(options.executeConcurrency),
    '--execute-timeout-ms',
    String(options.executeTimeoutMs),
    ...buildNodeBootstrapProbeOptionArgs(options)
  ];
}

function assertBootstrapApplyConfirmed(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (source.execute !== true || String(source.confirm || '').trim() !== 'execute') {
    const error = new Error('bootstrap_apply_confirmation_required');
    error.code = 'bootstrap_apply_confirmation_required';
    throw error;
  }
  if (String(source.inviteUrl || source.joinUrl || '').trim()) return;
  const error = new Error('missing_invite_url_for_apply');
  error.code = 'missing_invite_url_for_apply';
  throw error;
}

function buildInviteProbeCommand(result, payload) {
  const invite = result && result.invite ? result.invite : {};
  const source = payload && typeof payload === 'object' ? payload : {};
  const sshTargets = normalizeProbeTargetList(source.probeSshTargets);
  const tcpTargets = normalizeProbeTargetList(source.probeTcpTargets);
  return buildNodeBootstrapProbeCommand({
    sshTargets: sshTargets.length ? sshTargets : ['user@linux-host', 'user@mac-host'],
    tcpTargets: tcpTargets.length ? tcpTargets : ['windows-host'],
    ports: DEFAULT_TCP_PORTS,
    controlUrl: invite.controlEndpoint,
    inviteUrl: result && result.joinUrl,
    repoUrl: source.repoUrl,
    repoDir: source.repoDir,
    repoSubdir: source.repoSubdir,
    bootstrapTarget: source.bootstrapTarget,
    transportKind: invite.transportKind,
    endpoint: invite.transportKind === 'relay' ? '' : invite.endpointHint,
    concurrency: 3,
    timeoutMs: 3000
  });
}

function buildInviteJoinCommand(result, payload) {
  const invite = result && result.invite ? result.invite : {};
  const source = payload && typeof payload === 'object' ? payload : {};
  return formatNodeJoinCommand({
    target: resolveBootstrapTarget(source.bootstrapTarget),
    inviteUrl: result && result.joinUrl,
    endpoint: invite.transportKind === 'relay' ? '' : invite.endpointHint,
    nodeId: invite.nodeId,
    transportKind: invite.transportKind
  });
}

async function handleListRemoteNodes(ctx) {
  const deps = remoteDeps(ctx);
  const nodes = listRemoteNodeViews(deps, {
    includeAuthRef: true,
    includeTransportEndpoint: true,
    includeTransportSetupHint: true
  });
  ctx.writeJson(ctx.res, 200, { ok: true, nodes });
  return true;
}

async function handleUpsertRemoteNode(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const deps = remoteDeps(ctx);
  try {
    const hasNestedNodePayload = payload.node && typeof payload.node === 'object';
    const nodePayload = hasNestedNodePayload ? { ...payload, ...payload.node } : payload;
    const nodePayloadWithDefaults = applyRemoteNodeSaveDefaults(nodePayload, deps);
    const inlineTransportPayload = hasNestedNodePayload
      ? { ...payload, ...nodePayloadWithDefaults }
      : nodePayloadWithDefaults;
    const managementKey = payload.secret && typeof payload.secret === 'object'
      ? payload.secret.managementKey
      : payload.managementKey;
    const node = upsertRemoteNode(nodePayloadWithDefaults, deps);
    if (managementKey) {
      writeRemoteSecret(node.authRef, { managementKey }, deps);
    }
    const inlineTransport = buildInlineTransport(node, inlineTransportPayload);
    const transportInputs = Array.isArray(payload.transports)
      ? payload.transports
      : (payload.transport ? [payload.transport] : (inlineTransport ? [inlineTransport] : []));
    const transports = transportInputs.map((transport) => upsertRemoteTransport({
      ...transport,
      nodeId: node.id
    }, deps));
    ctx.writeJson(ctx.res, 200, { ok: true, node: serializeNode(node, transports.length ? transports : listNodeTransports(node.id, deps)) });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'remote_node_save_failed'),
      message: String((error && error.message) || error || 'remote_node_save_failed')
    });
  }
  return true;
}

async function handleListRemoteNodeInvites(ctx) {
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    invites: listRemoteNodeInvites(remoteDeps(ctx))
  });
  return true;
}

async function handleGetRemoteNodeDefaults(ctx) {
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    defaults: buildRemoteNodeDefaults({}, remoteDeps(ctx))
  });
  return true;
}

async function handleCreateRemoteNodeInvite(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    resolveBootstrapTarget(payload.bootstrapTarget);
    const result = createRemoteNodeInvite(buildInvitePayload(ctx, payload), remoteDeps(ctx));
    const bootstrap = buildInviteBootstrap(result, payload);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      ...result,
      warnings: buildInviteWarnings(result),
      joinCommand: buildInviteJoinCommand(result, payload),
      probeCommand: buildInviteProbeCommand(result, payload),
      bootstrap
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'remote_invite_create_failed'),
      message: String((error && error.message) || error || 'remote_invite_create_failed')
    });
  }
  return true;
}

async function handleBuildRemoteNodeBootstrapPlan(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    ctx.writeJson(ctx.res, 200, buildBootstrapPlanPayload(ctx, payload));
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'remote_bootstrap_plan_failed'),
      message: String((error && error.message) || error || 'remote_bootstrap_plan_failed')
    });
  }
  return true;
}

async function handleRunRemoteNodeBootstrapProbe(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const options = buildBootstrapProbeOptions(payload);
    const result = await runNodeBootstrapProbe(buildNodeBootstrapProbeOptionArgs(options), remoteDeps(ctx));
    const report = buildRemoteBootstrapProbeView(result.report, options);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      command: buildNodeBootstrapProbeCommand(options),
      applyCommand: buildNodeBootstrapApplyCommand(options),
      applyExecuteCommand: buildNodeBootstrapApplyCommand(options, {
        execute: true,
        assumeYes: true,
        executeConcurrency: options.executeConcurrency,
        executeTimeoutMs: options.executeTimeoutMs
      }),
      apply: buildNodeBootstrapApplyPreview(report, options),
      report
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: String((error && error.code) || 'remote_bootstrap_probe_failed'),
      message: String((error && error.message) || error || 'remote_bootstrap_probe_failed')
    });
  }
  return true;
}

async function handleRunRemoteNodeBootstrapApply(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    assertBootstrapApplyConfirmed(payload);
    const options = buildBootstrapProbeOptions(payload);
    const result = await runNodeBootstrapApply(buildBootstrapApplyArgs(options), remoteDeps(ctx));
    const report = buildRemoteBootstrapProbeView(result.probe && result.probe.report, options);
    ctx.writeJson(ctx.res, 200, {
      ok: result.ok,
      command: buildNodeBootstrapApplyCommand(options, {
        execute: true,
        assumeYes: true,
        executeConcurrency: options.executeConcurrency,
        executeTimeoutMs: options.executeTimeoutMs
      }),
      apply: {
        ok: result.ok,
        mode: result.mode,
        executeTimeoutMs: result.executeTimeoutMs,
        executeConcurrency: result.executeConcurrency,
        plan: result.plan
      },
      report
    });
  } catch (error) {
    const code = String((error && error.code) || 'remote_bootstrap_apply_failed');
    const requiredInputs = Array.isArray(error && error.requiredInputs)
      ? error.requiredInputs.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    ctx.writeJson(ctx.res, code === 'bootstrap_apply_confirmation_required' ? 409 : 400, {
      ok: false,
      error: code,
      message: code === 'bootstrap_apply_required_inputs_missing' && requiredInputs.length
        ? `Missing required bootstrap inputs: ${requiredInputs.join(', ')}`
        : String((error && error.message) || error || code),
      ...(requiredInputs.length ? { requiredInputs } : {})
    });
  }
  return true;
}

function writeRemoteGatewayError(ctx, error) {
  const details = error && error.details && typeof error.details === 'object' ? error.details : null;
  ctx.writeJson(ctx.res, Number(error && error.status) || 502, {
    ok: false,
    error: String((error && error.code) || 'remote_node_request_failed'),
    message: String((error && error.message) || error || 'remote_node_request_failed'),
    ...(details || {})
  });
}

async function handleRemoteManagementRequest(ctx, nodeId, route) {
  const deps = remoteDeps(ctx);
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, route.capability)) {
    ctx.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: route.capability
    });
    return true;
  }
  try {
    const result = await requestRemoteManagement({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: appendSearch(route.remotePath, ctx.url),
      method: route.method,
      rpc: route.key,
      scope: route.scope
    }, deps);
    ctx.writeJson(ctx.res, result.ok ? 200 : result.status || 502, { ok: result.ok, result });
  } catch (error) {
    writeRemoteGatewayError(ctx, error);
  }
  return true;
}

async function handleTestRemoteNode(ctx, nodeId) {
  return handleRemoteManagementRequest(ctx, nodeId, {
    key: 'node.status.read',
    remotePath: buildNodeRpcStatusPath(ctx, nodeId, { diagnostics: true }),
    method: 'GET',
    capability: 'status',
    scope: 'status:read'
  });
}

async function handleWebUiRemoteNodeRoutes(ctx) {
  const { method, pathname } = ctx;

  if (method === 'GET' && pathname === '/v0/webui/nodes/defaults') {
    return handleGetRemoteNodeDefaults(ctx);
  }

  if (method === 'GET' && pathname === '/v0/webui/nodes/invites') {
    return handleListRemoteNodeInvites(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/nodes/invites') {
    return handleCreateRemoteNodeInvite(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/nodes/bootstrap-plan') {
    return handleBuildRemoteNodeBootstrapPlan(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/nodes/bootstrap-probe') {
    return handleRunRemoteNodeBootstrapProbe(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/nodes/bootstrap-apply') {
    return handleRunRemoteNodeBootstrapApply(ctx);
  }

  if (method === 'GET' && pathname === '/v0/webui/nodes') {
    return handleListRemoteNodes(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/nodes') {
    return handleUpsertRemoteNode(ctx);
  }

  const testMatch = pathname.match(/^\/v0\/webui\/nodes\/([^/]+)\/test$/);
  if (method === 'POST' && testMatch) {
    return handleTestRemoteNode(ctx, normalizeId(decodeURIComponent(testMatch[1])));
  }

  const managementMatch = pathname.match(/^\/v0\/webui\/nodes\/([^/]+)\/management\/(.+)$/);
  if (managementMatch) {
    const route = matchRemoteManagementRoute(method, managementMatch[2]);
    if (!route) {
      ctx.writeJson(ctx.res, 404, { ok: false, error: 'remote_management_route_not_allowed' });
      return true;
    }
    return handleRemoteManagementRequest(ctx, normalizeId(decodeURIComponent(managementMatch[1])), route);
  }

  return false;
}

module.exports = {
  handleWebUiRemoteNodeRoutes
};
