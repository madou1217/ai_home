'use strict';

const { joinRemoteNodeWithInvite } = require('./remote/node-join');
const { buildControlPlaneDescriptor } = require('./control-plane-descriptor');
const { buildNodeDoctorReport } = require('../cli/services/node/doctor');
const {
  authorizeControlPlaneDeviceToken,
  consumeControlPlaneDeviceInvite
} = require('./control-plane-device-pairing');
const { buildControlPlaneDeviceAccounts } = require('./control-plane-device-accounts');
const {
  buildControlPlaneDeviceSessionEvents,
  buildControlPlaneDeviceSessionMessages,
  buildControlPlaneDeviceSessions
} = require('./control-plane-device-sessions');
const {
  attachRemoteDevelopmentSession,
  buildRemoteDevelopmentSessionCatalog
} = require('./control-plane-device-session-catalog');
const {
  buildForwardedSessionCommandPayload,
  executeRemoteDevelopmentSessionCommand
} = require('./control-plane-device-session-command');
const { readSessionArtifact } = require('./control-plane-device-session-artifact-store');
const { ackSessionEvents } = require('./control-plane-device-session-event-store');
const { writeDeviceSessionInput } = require('./control-plane-device-session-input');
const {
  abortNativeSessionRun,
  readNativeSessionRunEvents,
  startNativeDeviceSession,
  writeNativeSessionRunInput
} = require('./control-plane-device-session-start');
const { buildControlPlaneDeviceStatus } = require('./control-plane-device-status');
const { getRemoteNode, normalizeId } = require('./remote/node-registry');
const { listNodeTransports } = require('./remote/transport-registry');
const { listRemoteNodeViews } = require('./remote/remote-node-view');
const {
  requestRemoteManagement,
  streamRemoteManagement
} = require('./remote/remote-gateway');
const { nodeSupportsCapability } = require('./remote/remote-management-routes');
const {
  attachSseWatcher,
  openSseStream,
  removeSseWatcher,
  writeSseJson
} = require('./webui-sse-broadcaster');

const DEVICE_SESSION_REF_PATTERN = /^sess_[a-f0-9]{20}$/;
const DEFAULT_DEVICE_SESSION_STREAM_INTERVAL_MS = 1000;
const MIN_DEVICE_SESSION_STREAM_INTERVAL_MS = 500;
const MAX_DEVICE_SESSION_STREAM_INTERVAL_MS = 15000;
const DEFAULT_DEVICE_NODE_STREAM_RECONNECTS = 2;
const DEFAULT_DEVICE_NODE_STREAM_RECONNECT_DELAY_MS = 250;
const MAX_DEVICE_NODE_STREAM_RECONNECTS = 5;

function authorizeNodeRpc(ctx) {
  const { req, requiredManagementKey, deps } = ctx;
  const key = String(requiredManagementKey || '').trim();
  if (!key) return true;
  const incoming = deps.parseAuthorizationBearer(req.headers.authorization);
  return incoming === key;
}

function writeNodeRpcUnauthorized(ctx) {
  ctx.deps.writeJson(ctx.res, 401, {
    ok: false,
    error: 'unauthorized_node_rpc'
  });
}

function writeNodeRpcNotFound(ctx) {
  ctx.deps.writeJson(ctx.res, 404, {
    ok: false,
    error: 'node_rpc_not_found'
  });
}

function writeNodeRpcForbidden(ctx, statusCode, error) {
  ctx.deps.writeJson(ctx.res, statusCode, {
    ok: false,
    error
  });
}

function firstHeaderValue(headers, name) {
  const value = headers && headers[name];
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function inferRequestEndpoint(ctx) {
  const headers = ctx.req && ctx.req.headers ? ctx.req.headers : {};
  const host = firstHeaderValue(headers, 'x-forwarded-host') || firstHeaderValue(headers, 'host');
  if (!host) return '';
  const proto = firstHeaderValue(headers, 'x-forwarded-proto')
    || (ctx.url && ctx.url.protocol ? String(ctx.url.protocol).replace(/:$/, '') : 'http');
  return `${proto || 'http'}://${host}`;
}

function writePublicNodeRpcHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('cache-control', 'no-store');
}

function buildDevicePairWebRedirectUrl(url) {
  if (!url || !url.searchParams) return '';
  const code = String(url.searchParams.get('code') || '').trim();
  if (!code) return '';
  const marker = '/v0/node-rpc/device-pair';
  const markerIndex = String(url.pathname || '').indexOf(marker);
  const basePath = markerIndex > 0 ? url.pathname.slice(0, markerIndex) : '';
  const pairUrl = new URL(url.toString());
  const redirectUrl = new URL(`${basePath}/ui/settings`, `${url.protocol}//${url.host}`);
  redirectUrl.searchParams.set('pair', pairUrl.toString());
  return redirectUrl.toString();
}

function writeDevicePairWebRedirect(ctx) {
  const redirectUrl = buildDevicePairWebRedirectUrl(ctx.url);
  if (!redirectUrl) {
    writeNodeRpcNotFound(ctx);
    return true;
  }
  writePublicNodeRpcHeaders(ctx.res);
  ctx.res.statusCode = 302;
  ctx.res.setHeader('location', redirectUrl);
  ctx.res.end('');
  return true;
}

async function readJsonPayload(ctx) {
  if (!ctx.deps || typeof ctx.deps.readRequestBody !== 'function') return {};
  const body = await ctx.deps.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return {};
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function codeFromUrl(url) {
  return url && url.searchParams ? String(url.searchParams.get('code') || '').trim() : '';
}

function sessionRefFromUrl(url) {
  return String(url && url.searchParams ? url.searchParams.get('sessionRef') || '' : '').trim();
}

function isValidSessionRef(value) {
  return DEVICE_SESSION_REF_PATTERN.test(String(value || '').trim());
}

function streamIntervalFromUrl(url) {
  const value = Number(url && url.searchParams ? url.searchParams.get('intervalMs') : 0);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_DEVICE_SESSION_STREAM_INTERVAL_MS;
  }
  return Math.max(
    MIN_DEVICE_SESSION_STREAM_INTERVAL_MS,
    Math.min(MAX_DEVICE_SESSION_STREAM_INTERVAL_MS, Math.floor(value))
  );
}

function joinErrorStatus(code) {
  if (code === 'invite_not_found') return 404;
  if (code === 'invite_expired' || code === 'invite_already_consumed') return 410;
  return 400;
}

function devicePairErrorStatus(code) {
  if (code === 'device_invite_not_found') return 404;
  if (code === 'device_invite_expired' || code === 'device_invite_already_consumed') return 410;
  return 400;
}

async function handleNodeJoinRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = joinRemoteNodeWithInvite({
      ...payload,
      code: payload.code || codeFromUrl(ctx.url)
    }, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    });
    ctx.deps.writeJson(ctx.res, 200, { ok: true, ...result });
  } catch (error) {
    const code = String((error && error.code) || 'node_join_failed');
    ctx.deps.writeJson(ctx.res, joinErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

async function handleDevicePairRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = consumeControlPlaneDeviceInvite({
      ...payload,
      code: payload.code || codeFromUrl(ctx.url)
    }, {
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'control_plane.device.pair',
      ...result
    });
  } catch (error) {
    const code = String((error && error.code) || 'device_pair_failed');
    ctx.deps.writeJson(ctx.res, devicePairErrorStatus(code), {
      ok: false,
      error: code,
      message: String((error && error.message) || error || code)
    });
  }
  return true;
}

function buildDescriptorForRequest(ctx) {
  return buildControlPlaneDescriptor({
    options: ctx.options,
    state: ctx.state,
    requiredManagementKey: ctx.requiredManagementKey,
    endpoint: inferRequestEndpoint(ctx)
  });
}

function authorizeDeviceRequest(ctx, requiredScope) {
  const token = ctx.deps.parseAuthorizationBearer(ctx.req.headers.authorization);
  return authorizeControlPlaneDeviceToken(token, requiredScope, {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir
  });
}

function authorizeDeviceScopes(ctx, requiredScopes = []) {
  let authorized = null;
  for (const scope of requiredScopes) {
    const result = authorizeDeviceRequest(ctx, scope);
    if (!result.ok) return result;
    authorized = authorized || result;
  }
  return authorized || { ok: true };
}

function handleDeviceProfileRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'control-plane:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'control_plane.device.profile',
    result: {
      device: authorization.device,
      controlPlane: buildDescriptorForRequest(ctx)
    }
  });
  return true;
}

function handleDeviceNodesRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'nodes:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'control_plane.device.nodes',
    result: {
      nodes: listRemoteNodeViews({
        fs: ctx.deps.fs,
        aiHomeDir: ctx.deps.aiHomeDir,
        relaySessionRegistry: ctx.deps.relaySessionRegistry
      })
    }
  });
  return true;
}

function nodeIdFromUrl(url) {
  return normalizeId(url && url.searchParams ? url.searchParams.get('nodeId') : '');
}

function nodeIdFromPayload(payload) {
  return normalizeId(payload && typeof payload === 'object' ? payload.nodeId : '');
}

function buildDeviceNodeSessionMessagesPath(ctx, sessionRef) {
  const params = new URLSearchParams({ sessionRef });
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  const limit = source.get('limit');
  if (limit !== null && limit !== '') params.set('limit', limit);
  return `/v0/node-rpc/session-messages?${params.toString()}`;
}

function buildDeviceSessionsOptions(ctx) {
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  return {
    limit: source.get('limit') || undefined
  };
}

function buildDeviceNodeSessionsPath(ctx) {
  const params = new URLSearchParams();
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  const limit = source.get('limit');
  const refresh = source.get('refresh');
  if (limit !== null && limit !== '') params.set('limit', limit);
  if (refresh !== null && refresh !== '') params.set('refresh', refresh);
  const suffix = params.toString();
  return suffix ? `/v0/node-rpc/sessions?${suffix}` : '/v0/node-rpc/sessions';
}

function buildDeviceNodeSessionCatalogPath(ctx) {
  const params = new URLSearchParams();
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  ['limit', 'refresh'].forEach((name) => {
    const value = source.get(name);
    if (value !== null && value !== '') params.set(name, value);
  });
  const suffix = params.toString();
  return suffix ? `/v0/node-rpc/session-catalog?${suffix}` : '/v0/node-rpc/session-catalog';
}

function buildDeviceNodeSessionStreamPath(ctx, sessionRef) {
  const params = new URLSearchParams({ sessionRef });
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  ['cursor', 'limit', 'intervalMs'].forEach((name) => {
    const value = source.get(name);
    if (value !== null && value !== '') params.set(name, value);
  });
  return `/v0/node-rpc/session-stream?${params.toString()}`;
}

function buildDeviceNodeSessionInputPayload(payload, sessionRef) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionRef,
    input: String(source.input == null ? '' : source.input),
    appendNewline: source.appendNewline !== false,
    promptId: String(source.promptId || '').trim()
  };
}

function buildDeviceNodeSessionResumePath(ctx, sessionRef, cursor) {
  const params = new URLSearchParams({ sessionRef });
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  const normalizedCursor = Number(cursor);
  if (Number.isFinite(normalizedCursor) && normalizedCursor > 0) {
    params.set('cursor', String(Math.floor(normalizedCursor)));
  } else {
    const value = source.get('cursor');
    if (value !== null && value !== '') params.set('cursor', value);
  }
  ['limit', 'intervalMs'].forEach((name) => {
    const value = source.get(name);
    if (value !== null && value !== '') params.set(name, value);
  });
  return `/v0/node-rpc/session-stream?${params.toString()}`;
}

function cursorFromRemoteSessionFrame(frame) {
  const cursor = Number(frame && frame.result && frame.result.cursor);
  return Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

function deviceNodeStreamReconnects(ctx) {
  const value = Number(ctx && ctx.deps && ctx.deps.deviceNodeStreamReconnects);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DEVICE_NODE_STREAM_RECONNECTS;
  return Math.min(MAX_DEVICE_NODE_STREAM_RECONNECTS, Math.floor(value));
}

function deviceNodeStreamReconnectDelayMs(ctx) {
  const value = Number(ctx && ctx.deps && ctx.deps.deviceNodeStreamReconnectDelayMs);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DEVICE_NODE_STREAM_RECONNECT_DELAY_MS;
  return Math.floor(value);
}

function isRetryableRemoteStreamError(error, signal) {
  if (signal && signal.aborted) return false;
  const status = Number(error && error.status);
  if (status === 499 || status === 401 || status === 403 || status === 404) return false;
  if (status === 502 || status === 503 || status === 504) return true;
  const code = String((error && error.code) || '').toLowerCase();
  if (!code || code.includes('aborted')) return false;
  return /session_closed|session_error|stream_timeout|stream_failed|unavailable|send_failed/.test(code);
}

function waitForDeviceNodeStreamReconnect(ctx, signal) {
  const delayMs = deviceNodeStreamReconnectDelayMs(ctx);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    function cleanup() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error('remote_node_session_stream_aborted');
      error.code = 'remote_node_session_stream_aborted';
      error.status = 499;
      reject(error);
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isWritableResponse(res) {
  return Boolean(res && !res.destroyed && !res.writableEnded);
}

function normalizeRemoteSessionStreamChunk(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (source.type !== 'events' || !source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_stream',
    type: 'events',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionMessagesResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_messages',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionsResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_sessions',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionCatalogResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_catalog',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionAttachResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_attach',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionCommandResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_command',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionAckResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_ack',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionArtifactResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_artifact',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionInputResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_input',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionStartResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_start',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionRunEventsResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_run_events',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionRunInputResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_run_input',
    nodeId: node.id,
    result: source.result
  };
}

function normalizeRemoteSessionRunAbortResult(node, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!source.result || typeof source.result !== 'object') return null;
  return {
    ok: source.ok !== false,
    rpc: 'control_plane.device.node_session_run_abort',
    nodeId: node.id,
    result: source.result
  };
}

async function handleDeviceNodeSessionsRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: buildDeviceNodeSessionsPath(ctx),
      method: 'GET',
      rpc: 'control_plane.device.node_sessions',
      scope: 'sessions:read'
    }, deps);
    const payload = normalizeRemoteSessionsResult(node, result && result.payload);
    if (!result.ok || !payload) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_sessions_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, payload);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_sessions_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionCatalogRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: buildDeviceNodeSessionCatalogPath(ctx),
      method: 'GET',
      rpc: 'control_plane.device.node_session_catalog',
      scope: 'sessions:read'
    }, deps);
    const payload = normalizeRemoteSessionCatalogResult(node, result && result.payload);
    if (!result.ok || !payload) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_catalog_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, payload);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_catalog_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionMessagesRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  const sessionRef = sessionRefFromUrl(ctx.url);
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: buildDeviceNodeSessionMessagesPath(ctx, sessionRef),
      method: 'GET',
      rpc: 'control_plane.device.node_session_messages',
      scope: 'sessions:read'
    }, deps);
    const payload = normalizeRemoteSessionMessagesResult(node, result && result.payload);
    if (!result.ok || !payload) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_messages_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, payload);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_messages_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionInputRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  const sessionRef = String(payload.sessionRef || '').trim();
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-input',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionInputPayload(payload, sessionRef)),
      rpc: 'control_plane.device.node_session_input',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionInputResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_input_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_input_failed')
    });
  }
  return true;
}

function buildDeviceNodeSessionStartPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    provider: String(source.provider || '').trim(),
    accountId: String(source.accountId || source.account_id || '').trim(),
    prompt: String(source.prompt || source.initialInput || source.initial_input || ''),
    projectPath: String(source.projectPath || source.project_path || '').trim(),
    projectDirName: String(source.projectDirName || source.project_dir_name || '').trim(),
    model: String(source.model || '').trim(),
    sessionId: String(source.sessionId || source.session_id || '').trim(),
    cols: Number(source.cols) || undefined,
    rows: Number(source.rows) || undefined
  };
}

function buildDeviceNodeSessionRunEventsPath(ctx, runId) {
  const params = new URLSearchParams({ runId });
  const source = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : new URLSearchParams();
  ['cursor', 'limit'].forEach((name) => {
    const value = source.get(name);
    if (value !== null && value !== '') params.set(name, value);
  });
  return `/v0/node-rpc/session-run-events?${params.toString()}`;
}

function artifactIdFromUrl(url) {
  return String(url && url.searchParams ? url.searchParams.get('artifactId') || url.searchParams.get('artifact_id') || '' : '').trim();
}

function buildDeviceNodeSessionArtifactPath(ctx, artifactId) {
  const params = new URLSearchParams({ artifactId });
  return `/v0/node-rpc/session-artifact?${params.toString()}`;
}

function buildDeviceNodeSessionRunInputPayload(payload, runId) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    runId,
    input: String(source.input == null ? '' : source.input),
    appendNewline: source.appendNewline !== false,
    promptId: String(source.promptId || '').trim()
  };
}

function buildDeviceNodeSessionRunAbortPayload(payload, runId) {
  return { runId };
}

function buildDeviceNodeSessionAttachPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: String(source.sessionId || source.session_id || source.runId || source.run_id || source.sessionRef || '').trim(),
    cursor: Number(source.cursor) || 0,
    limit: Number(source.limit) || undefined
  };
}

function buildDeviceNodeSessionAckPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: String(source.sessionId || source.session_id || source.runId || source.run_id || source.sessionRef || '').trim(),
    cursor: Number(source.cursor || source.seq || source.sequence) || 0,
    consumerId: String(source.consumerId || source.consumer_id || source.clientId || source.client_id || '').trim()
  };
}

function runIdFromUrl(url) {
  return String(url && url.searchParams ? url.searchParams.get('runId') || '' : '').trim();
}

function runIdFromPayload(payload) {
  return String(payload && typeof payload === 'object' ? payload.runId || payload.run_id || '' : '').trim();
}

async function handleDeviceNodeSessionStartRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-start',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionStartPayload(payload)),
      rpc: 'control_plane.device.node_session_start',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionStartResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_start_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_start_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionAttachRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-attach',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionAttachPayload(payload)),
      rpc: 'control_plane.device.node_session_attach',
      scope: 'sessions:read'
    }, deps);
    const normalized = normalizeRemoteSessionAttachResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_attach_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_attach_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionCommandRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-command',
      method: 'POST',
      body: JSON.stringify(buildForwardedSessionCommandPayload(payload)),
      rpc: 'control_plane.device.node_session_command',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionCommandResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_command_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && (error.status || error.statusCode)) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_command_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionAckRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-ack',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionAckPayload(payload)),
      rpc: 'control_plane.device.node_session_ack',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionAckResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_ack_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && (error.status || error.statusCode)) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_ack_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionRunEventsRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  const runId = runIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  if (!runId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_run_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: buildDeviceNodeSessionRunEventsPath(ctx, runId),
      method: 'GET',
      rpc: 'control_plane.device.node_session_run_events',
      scope: 'sessions:read'
    }, deps);
    const normalized = normalizeRemoteSessionRunEventsResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_run_events_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_run_events_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionArtifactRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  const artifactId = artifactIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  if (!artifactId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_artifact_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: buildDeviceNodeSessionArtifactPath(ctx, artifactId),
      method: 'GET',
      rpc: 'control_plane.device.node_session_artifact',
      scope: 'sessions:read'
    }, deps);
    const normalized = normalizeRemoteSessionArtifactResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_artifact_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_artifact_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionRunInputRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  const runId = runIdFromPayload(payload) || runIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  if (!runId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_run_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-run-input',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionRunInputPayload(payload, runId)),
      rpc: 'control_plane.device.node_session_run_input',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionRunInputResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_run_input_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_run_input_failed')
    });
  }
  return true;
}

async function handleDeviceNodeSessionRunAbortRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:write']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const nodeId = nodeIdFromPayload(payload) || nodeIdFromUrl(ctx.url);
  const runId = runIdFromPayload(payload) || runIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  if (!runId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_run_id' });
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    requestRelayManagement: ctx.deps.requestRelayManagement,
    relaySessionRegistry: ctx.deps.relaySessionRegistry
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  try {
    const request = typeof ctx.deps.requestRemoteManagement === 'function'
      ? ctx.deps.requestRemoteManagement
      : requestRemoteManagement;
    const result = await request({
      node,
      transports: listNodeTransports(node.id, deps),
      pathname: '/v0/node-rpc/session-run-abort',
      method: 'POST',
      body: JSON.stringify(buildDeviceNodeSessionRunAbortPayload(payload, runId)),
      rpc: 'control_plane.device.node_session_run_abort',
      scope: 'sessions:write'
    }, deps);
    const normalized = normalizeRemoteSessionRunAbortResult(node, result && result.payload);
    if (!result.ok || !normalized) {
      ctx.deps.writeJson(ctx.res, Number(result && result.status) || 502, {
        ok: false,
        error: 'remote_node_session_run_abort_failed'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, normalized);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
      ok: false,
      error: String((error && error.code) || 'remote_node_session_run_abort_failed')
    });
  }
  return true;
}

async function streamDeviceNodeSessionWithResume(input = {}) {
  const {
    ctx,
    deps,
    node,
    sessionRef,
    signal,
    stream,
    onOpen,
    onFrame
  } = input;
  const maxReconnects = deviceNodeStreamReconnects(ctx);
  let reconnects = 0;
  let latestCursor = 0;

  while (true) {
    try {
      return await stream({
        node,
        transports: listNodeTransports(node.id, deps),
        pathname: latestCursor > 0
          ? buildDeviceNodeSessionResumePath(ctx, sessionRef, latestCursor)
          : buildDeviceNodeSessionStreamPath(ctx, sessionRef),
        method: 'GET',
        rpc: 'control_plane.device.node_session_stream',
        scope: 'sessions:read',
        streamKind: 'session',
        signal
      }, {
        onOpen,
        onChunk: (payload) => {
          const frame = normalizeRemoteSessionStreamChunk(node, payload);
          if (!frame) return;
          latestCursor = Math.max(latestCursor, cursorFromRemoteSessionFrame(frame));
          onFrame(frame);
        }
      }, deps);
    } catch (error) {
      if (!input.isOpen() || reconnects >= maxReconnects || !isRetryableRemoteStreamError(error, signal)) {
        throw error;
      }
      reconnects += 1;
      await waitForDeviceNodeStreamReconnect(ctx, signal);
    }
  }
}

async function handleDeviceNodeSessionStreamRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceScopes(ctx, ['nodes:read', 'sessions:read']);
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const nodeId = nodeIdFromUrl(ctx.url);
  if (!nodeId) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'missing_or_invalid_node_id' });
    return true;
  }
  const sessionRef = sessionRefFromUrl(ctx.url);
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }

  const deps = {
    fs: ctx.deps.fs,
    aiHomeDir: ctx.deps.aiHomeDir,
    fetchImpl: ctx.deps.fetchImpl,
    relaySessionRegistry: ctx.deps.relaySessionRegistry,
    requestRelayManagementStream: ctx.deps.requestRelayManagementStream
  };
  const node = getRemoteNode(nodeId, deps);
  if (!node) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'remote_node_not_found' });
    return true;
  }
  if (!nodeSupportsCapability(node, 'sessions')) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'remote_node_capability_denied',
      capability: 'sessions'
    });
    return true;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const cleanup = () => {
    if (controller && !controller.signal.aborted) controller.abort();
  };
  if (ctx.req && typeof ctx.req.on === 'function') ctx.req.on('close', cleanup);
  if (ctx.res && typeof ctx.res.on === 'function') {
    ctx.res.on('close', cleanup);
    ctx.res.on('error', cleanup);
  }

  let opened = false;
  const open = () => {
    if (opened || !isWritableResponse(ctx.res)) return;
    opened = true;
    openSseStream(ctx.res);
  };

  try {
    const stream = typeof ctx.deps.streamRemoteManagement === 'function'
      ? ctx.deps.streamRemoteManagement
      : streamRemoteManagement;
    const result = await streamDeviceNodeSessionWithResume({
      ctx,
      deps,
      node,
      sessionRef,
      signal: controller && controller.signal,
      stream,
      onOpen: (message) => {
        if (message && message.ok === false) return;
        open();
      },
      onFrame: (frame) => {
        open();
        if (!writeSseJson(ctx.res, frame)) cleanup();
      },
      isOpen: () => opened
    });
    if (!opened) {
      ctx.deps.writeJson(ctx.res, result.ok ? 204 : result.status || 502, {
        ok: result.ok,
        result
      });
      return true;
    }
    if (isWritableResponse(ctx.res)) ctx.res.end();
  } catch (error) {
    if (!opened) {
      ctx.deps.writeJson(ctx.res, Number(error && error.status) || 502, {
        ok: false,
        error: String((error && error.code) || 'remote_node_session_stream_failed')
      });
      return true;
    }
    if (isWritableResponse(ctx.res)) ctx.res.end();
  }
  return true;
}

function handleDeviceStatusRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'status:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const status = ctx.deps.buildManagementStatusPayload(ctx.state, ctx.options, {
    accountStateIndex: ctx.deps.accountStateIndex
  });
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'control_plane.device.status',
    result: {
      status: buildControlPlaneDeviceStatus(status)
    }
  });
  return true;
}

function shouldIncludeNodeDiagnostics(url) {
  if (!url || !url.searchParams) return false;
  const value = String(url.searchParams.get('diagnostics') || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function buildNodeDiagnosticsForRequest(ctx) {
  const readServerConfig = typeof ctx.deps.readServerConfig === 'function'
    ? ctx.deps.readServerConfig
    : () => ({});
  const runtimeOptions = ctx.options && typeof ctx.options === 'object' ? ctx.options : {};
  const readRuntimeServerConfig = () => {
    const config = readServerConfig() || {};
    const patch = {};
    if (runtimeOptions.host !== undefined) patch.host = runtimeOptions.host;
    if (runtimeOptions.port !== undefined) patch.port = runtimeOptions.port;
    if (runtimeOptions.managementKey !== undefined) patch.managementKey = runtimeOptions.managementKey;
    if (runtimeOptions.openNetwork !== undefined) patch.openNetwork = runtimeOptions.openNetwork;
    return { ...config, ...patch };
  };
  return buildNodeDoctorReport({
    controlUrl: String(ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('controlUrl') || '' : '').trim(),
    nodeId: String(ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('nodeId') || '' : '').trim()
  }, {
    fs: ctx.deps.fs,
    path: ctx.deps.path,
    aiHomeDir: ctx.deps.aiHomeDir,
    hostHomeDir: ctx.deps.hostHomeDir,
    hostname: ctx.deps.hostname,
    processObj: ctx.deps.processObj,
    platform: ctx.deps.platform,
    arch: ctx.deps.arch,
    spawnSync: ctx.deps.spawnSync,
    readServerConfig: readRuntimeServerConfig,
    networkInterfaces: ctx.deps.networkInterfaces
  });
}

function attachNodeDiagnostics(status, ctx) {
  if (!shouldIncludeNodeDiagnostics(ctx.url)) return status;
  return {
    ...status,
    nodeDiagnostics: buildNodeDiagnosticsForRequest(ctx)
  };
}

function handleDeviceAccountsRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'accounts:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const accounts = ctx.deps.buildManagementAccountsPayload(ctx.state, {
    fs: ctx.deps.fs,
    getProfileDir: ctx.deps.getProfileDir,
    getToolConfigDir: ctx.deps.getToolConfigDir,
    accountStateIndex: ctx.deps.accountStateIndex
  });
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'control_plane.device.accounts',
    result: buildControlPlaneDeviceAccounts(accounts)
  });
  return true;
}

function writeInvalidSessionRef(ctx) {
  ctx.deps.writeJson(ctx.res, 400, {
    ok: false,
    error: 'missing_or_invalid_session_ref'
  });
}

async function loadDeviceProjectsSnapshot(ctx) {
  if (ctx.deps && typeof ctx.deps.getProjectsSnapshot === 'function') {
    return ctx.deps.getProjectsSnapshot({
      state: ctx.state,
      options: ctx.options,
      fs: ctx.deps.fs,
      aiHomeDir: ctx.deps.aiHomeDir,
      deps: ctx.deps
    }, {
      forceRefresh: ctx.url && ctx.url.searchParams && ctx.url.searchParams.get('refresh') === '1',
      waitForRefresh: false
    });
  }
  return { projects: [] };
}

async function handleDeviceSessionsRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'sessions:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_sessions_unavailable'
    });
    return true;
  }
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'control_plane.device.sessions',
    result: buildControlPlaneDeviceSessions(projectsSnapshot, buildDeviceSessionsOptions(ctx))
  });
  return true;
}

async function handleNodeSessionsRequest(ctx) {
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'node_sessions_unavailable'
    });
    return true;
  }
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'node.sessions',
    result: buildControlPlaneDeviceSessions(projectsSnapshot, buildDeviceSessionsOptions(ctx))
  });
  return true;
}

async function handleNodeSessionCatalogRequest(ctx) {
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'node_session_catalog_unavailable'
    });
    return true;
  }
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'node.session_catalog',
    result: buildRemoteDevelopmentSessionCatalog(projectsSnapshot, buildDeviceSessionsOptions(ctx), getSessionCatalogDeps(ctx))
  });
  return true;
}

function getSessionReaderDeps(ctx) {
  if (ctx.deps && (typeof ctx.deps.readSessionMessages === 'function' || typeof ctx.deps.readSessionEvents === 'function')) {
    return {
      readSessionEvents: ctx.deps.readSessionEvents,
      readSessionMessages: ctx.deps.readSessionMessages,
      getSessionFileCursor: ctx.deps.getSessionFileCursor
    };
  }
  const {
    getSessionFileCursor,
    readSessionEvents,
    readSessionMessages
  } = require('../sessions/session-reader');
  return {
    getSessionFileCursor,
    readSessionEvents,
    readSessionMessages
  };
}

async function handleAuthorizedSessionMessagesRequest(ctx, rpc) {
  const sessionRef = sessionRefFromUrl(ctx.url);
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_sessions_unavailable'
    });
    return true;
  }
  try {
    const result = buildControlPlaneDeviceSessionMessages(projectsSnapshot, {
      sessionRef,
      limit: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : undefined
    }, getSessionReaderDeps(ctx));
    if (!result) {
      ctx.deps.writeJson(ctx.res, 404, {
        ok: false,
        error: 'control_plane_device_session_not_found'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc,
      result
    });
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_session_messages_unavailable'
    });
  }
  return true;
}

function getSessionCatalogDeps(ctx) {
  return {
    ...getSessionReaderDeps(ctx),
    listNativeChatRuns: ctx.deps.listNativeChatRuns,
    getNativeChatRun: ctx.deps.getNativeChatRun,
    readNativeSessionRunEvents: ctx.deps.readNativeSessionRunEvents
  };
}

async function handleDeviceSessionMessagesRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'sessions:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  return handleAuthorizedSessionMessagesRequest(ctx, 'control_plane.device.session_messages');
}

async function handleNodeSessionMessagesRequest(ctx) {
  return handleAuthorizedSessionMessagesRequest(ctx, 'node.session_messages');
}

async function handleDeviceSessionEventsRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'sessions:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  const sessionRef = sessionRefFromUrl(ctx.url);
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_sessions_unavailable'
    });
    return true;
  }
  try {
    const result = buildControlPlaneDeviceSessionEvents(projectsSnapshot, {
      sessionRef,
      cursor: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('cursor') : undefined,
      limit: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : undefined
    }, getSessionReaderDeps(ctx));
    if (!result) {
      ctx.deps.writeJson(ctx.res, 404, {
        ok: false,
        error: 'control_plane_device_session_not_found'
      });
      return true;
    }
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'control_plane.device.session_events',
      result
    });
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_session_events_unavailable'
    });
  }
  return true;
}

function buildSessionStreamPayload(result, rpc) {
  return {
    ok: true,
    rpc,
    type: 'events',
    result
  };
}

function writeSessionStreamFrame(ctx, result, rpc) {
  return writeSseJson(ctx.res, buildSessionStreamPayload(result, rpc));
}

async function handleAuthorizedSessionStreamRequest(ctx, rpc) {
  const sessionRef = sessionRefFromUrl(ctx.url);
  if (!isValidSessionRef(sessionRef)) {
    writeInvalidSessionRef(ctx);
    return true;
  }

  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_sessions_unavailable'
    });
    return true;
  }

  const input = {
    sessionRef,
    cursor: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('cursor') : undefined,
    limit: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : undefined
  };
  const readerDeps = getSessionReaderDeps(ctx);
  let firstResult = null;
  try {
    firstResult = buildControlPlaneDeviceSessionEvents(projectsSnapshot, input, readerDeps);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'control_plane_device_session_stream_unavailable'
    });
    return true;
  }
  if (!firstResult) {
    ctx.deps.writeJson(ctx.res, 404, {
      ok: false,
      error: 'control_plane_device_session_not_found'
    });
    return true;
  }

  const intervalMs = streamIntervalFromUrl(ctx.url);
  const timers = {
    setInterval: ctx.deps.setInterval || setInterval,
    clearInterval: ctx.deps.clearInterval || clearInterval
  };
  const watchers = new Set();
  let cursor = firstResult.cursor;
  let closed = false;
  let polling = false;
  let pollTimer = null;
  let sseWatcher = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) {
      try {
        timers.clearInterval(pollTimer);
      } catch (_error) {}
      pollTimer = null;
    }
    if (sseWatcher) {
      removeSseWatcher(watchers, sseWatcher);
      sseWatcher = null;
    }
  };

  const poll = () => {
    if (closed || polling) return;
    polling = true;
    try {
      const nextResult = buildControlPlaneDeviceSessionEvents(projectsSnapshot, {
        ...input,
        cursor
      }, readerDeps);
      if (!nextResult) {
        cleanup();
        return;
      }
      const shouldWrite = nextResult.events.length > 0
        || nextResult.requiresSnapshot
        || nextResult.truncated
        || nextResult.cursor !== cursor;
      cursor = nextResult.cursor;
      if (shouldWrite && !writeSessionStreamFrame(ctx, nextResult, rpc)) {
        cleanup();
      }
    } catch (_error) {
      cleanup();
    } finally {
      polling = false;
    }
  };

  openSseStream(ctx.res);
  sseWatcher = attachSseWatcher(watchers, ctx.req, ctx.res, { onWatcherRemoved: cleanup });
  if (!writeSessionStreamFrame(ctx, firstResult, rpc)) {
    cleanup();
    return true;
  }

  pollTimer = timers.setInterval(poll, intervalMs);
  if (pollTimer && typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
  if (ctx.req && typeof ctx.req.on === 'function') ctx.req.on('close', cleanup);
  if (ctx.res && typeof ctx.res.on === 'function') {
    ctx.res.on('close', cleanup);
    ctx.res.on('error', cleanup);
  }
  return true;
}

async function handleDeviceSessionStreamRequest(ctx) {
  writePublicNodeRpcHeaders(ctx.res);
  const authorization = authorizeDeviceRequest(ctx, 'sessions:read');
  if (!authorization.ok) {
    writeNodeRpcForbidden(ctx, authorization.statusCode, authorization.error);
    return true;
  }
  return handleAuthorizedSessionStreamRequest(ctx, 'control_plane.device.session_stream');
}

async function handleNodeSessionStreamRequest(ctx) {
  return handleAuthorizedSessionStreamRequest(ctx, 'node.session_stream');
}

async function handleNodeSessionInputRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'node_session_input_unavailable'
    });
    return true;
  }
  try {
    const result = writeDeviceSessionInput(projectsSnapshot, payload, {
      findNativeChatRunBySession: ctx.deps.findNativeChatRunBySession,
      unregisterNativeChatRun: ctx.deps.unregisterNativeChatRun
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_input',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_input_failed')
    });
  }
  return true;
}

async function handleNodeSessionStartRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const starter = typeof ctx.deps.startNativeDeviceSession === 'function'
      ? ctx.deps.startNativeDeviceSession
      : startNativeDeviceSession;
    const result = starter(payload, {
      getProfileDir: ctx.deps.getProfileDir,
      ensureSessionStoreLinks: ctx.deps.ensureSessionStoreLinks,
      registerNativeChatRun: ctx.deps.registerNativeChatRun,
      unregisterNativeChatRun: ctx.deps.unregisterNativeChatRun,
      env: ctx.deps.env || process.env
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_start',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_start_failed'),
      message: String((error && error.message) || error || 'node_session_start_failed')
    });
  }
  return true;
}

async function handleNodeSessionAttachRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  let projectsSnapshot = null;
  try {
    projectsSnapshot = await loadDeviceProjectsSnapshot(ctx);
  } catch (_error) {
    ctx.deps.writeJson(ctx.res, 500, {
      ok: false,
      error: 'node_session_attach_unavailable'
    });
    return true;
  }
  try {
    const result = attachRemoteDevelopmentSession(projectsSnapshot, payload, getSessionCatalogDeps(ctx));
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_attach',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_attach_failed')
    });
  }
  return true;
}

async function handleNodeSessionCommandRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const result = await executeRemoteDevelopmentSessionCommand(payload, {
      writeNativeSessionRunInput: ctx.deps.writeNativeSessionRunInput,
      abortNativeSessionRun: ctx.deps.abortNativeSessionRun,
      readNativeSessionRunEvents: ctx.deps.readNativeSessionRunEvents,
      writeDeviceSessionInput: ctx.deps.writeDeviceSessionInput,
      findNativeChatRunBySession: ctx.deps.findNativeChatRunBySession,
      unregisterNativeChatRun: ctx.deps.unregisterNativeChatRun,
      loadProjectsSnapshot: () => loadDeviceProjectsSnapshot(ctx)
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_command',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_command_failed')
    });
  }
  return true;
}

async function handleNodeSessionAckRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const ack = typeof ctx.deps.ackSessionEvents === 'function'
      ? ctx.deps.ackSessionEvents(payload)
      : ackSessionEvents(payload);
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_ack',
      result: ack
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_ack_failed')
    });
  }
  return true;
}

async function handleNodeSessionRunEventsRequest(ctx) {
  try {
    const reader = typeof ctx.deps.readNativeSessionRunEvents === 'function'
      ? ctx.deps.readNativeSessionRunEvents
      : readNativeSessionRunEvents;
    const result = reader({
      runId: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('runId') : '',
      cursor: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('cursor') : '',
      limit: ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : ''
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_run_events',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_run_events_failed')
    });
  }
  return true;
}

async function handleNodeSessionArtifactRequest(ctx) {
  try {
    const reader = typeof ctx.deps.readSessionArtifact === 'function'
      ? ctx.deps.readSessionArtifact
      : readSessionArtifact;
    const result = reader({
      artifactId: artifactIdFromUrl(ctx.url)
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_artifact',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_artifact_failed')
    });
  }
  return true;
}

async function handleNodeSessionRunInputRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const writer = typeof ctx.deps.writeNativeSessionRunInput === 'function'
      ? ctx.deps.writeNativeSessionRunInput
      : writeNativeSessionRunInput;
    const result = writer(payload);
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_run_input',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_run_input_failed')
    });
  }
  return true;
}

async function handleNodeSessionRunAbortRequest(ctx) {
  const payload = await readJsonPayload(ctx);
  if (!payload || typeof payload !== 'object') {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  try {
    const aborter = typeof ctx.deps.abortNativeSessionRun === 'function'
      ? ctx.deps.abortNativeSessionRun
      : abortNativeSessionRun;
    const result = aborter(payload, {
      unregisterNativeChatRun: ctx.deps.unregisterNativeChatRun
    });
    ctx.deps.writeJson(ctx.res, 200, {
      ok: true,
      rpc: 'node.session_run_abort',
      result
    });
  } catch (error) {
    ctx.deps.writeJson(ctx.res, Number(error && error.statusCode) || 400, {
      ok: false,
      error: String((error && error.code) || 'node_session_run_abort_failed')
    });
  }
  return true;
}

async function handleNodeRpcRequest(ctx) {
  const { method, pathname, res, options, state, deps } = ctx;
  if (!String(pathname || '').startsWith('/v0/node-rpc')) return false;

  if (method === 'OPTIONS' && (
    pathname === '/v0/node-rpc/descriptor'
    || pathname === '/v0/node-rpc/device-pair'
    || pathname === '/v0/node-rpc/device-profile'
    || pathname === '/v0/node-rpc/device-status'
    || pathname === '/v0/node-rpc/device-accounts'
    || pathname === '/v0/node-rpc/device-sessions'
    || pathname === '/v0/node-rpc/device-session-messages'
    || pathname === '/v0/node-rpc/device-session-events'
    || pathname === '/v0/node-rpc/device-session-stream'
    || pathname === '/v0/node-rpc/device-node-sessions'
    || pathname === '/v0/node-rpc/device-node-session-catalog'
    || pathname === '/v0/node-rpc/device-node-session-messages'
    || pathname === '/v0/node-rpc/device-node-session-stream'
    || pathname === '/v0/node-rpc/device-node-session-input'
    || pathname === '/v0/node-rpc/device-node-session-start'
    || pathname === '/v0/node-rpc/device-node-session-attach'
    || pathname === '/v0/node-rpc/device-node-session-command'
    || pathname === '/v0/node-rpc/device-node-session-ack'
    || pathname === '/v0/node-rpc/device-node-session-run-events'
    || pathname === '/v0/node-rpc/device-node-session-artifact'
    || pathname === '/v0/node-rpc/device-node-session-run-input'
    || pathname === '/v0/node-rpc/device-node-session-run-abort'
    || pathname === '/v0/node-rpc/device-nodes'
  )) {
    writePublicNodeRpcHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/join') {
    return handleNodeJoinRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-pair') {
    return writeDevicePairWebRedirect(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-pair') {
    return handleDevicePairRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/descriptor') {
    writePublicNodeRpcHeaders(res);
    deps.writeJson(res, 200, {
      ok: true,
      rpc: 'control_plane.descriptor.read',
      result: buildDescriptorForRequest(ctx)
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-profile') {
    return handleDeviceProfileRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-status') {
    return handleDeviceStatusRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-accounts') {
    return handleDeviceAccountsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-sessions') {
    return handleDeviceSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-messages') {
    return handleDeviceSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-events') {
    return handleDeviceSessionEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-session-stream') {
    return handleDeviceSessionStreamRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-sessions') {
    return handleDeviceNodeSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-catalog') {
    return handleDeviceNodeSessionCatalogRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-messages') {
    return handleDeviceNodeSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-stream') {
    return handleDeviceNodeSessionStreamRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-input') {
    return handleDeviceNodeSessionInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-start') {
    return handleDeviceNodeSessionStartRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-attach') {
    return handleDeviceNodeSessionAttachRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-command') {
    return handleDeviceNodeSessionCommandRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-ack') {
    return handleDeviceNodeSessionAckRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-run-events') {
    return handleDeviceNodeSessionRunEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-node-session-artifact') {
    return handleDeviceNodeSessionArtifactRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-run-input') {
    return handleDeviceNodeSessionRunInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/device-node-session-run-abort') {
    return handleDeviceNodeSessionRunAbortRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/device-nodes') {
    return handleDeviceNodesRequest(ctx);
  }

  if (!authorizeNodeRpc(ctx)) {
    writeNodeRpcUnauthorized(ctx);
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/status') {
    const status = deps.buildManagementStatusPayload(state, options, {
      accountStateIndex: deps.accountStateIndex
    });
    deps.writeJson(res, 200, {
      ok: true,
      rpc: 'node.status.read',
      result: attachNodeDiagnostics(status, ctx)
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/sessions') {
    return handleNodeSessionsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-catalog') {
    return handleNodeSessionCatalogRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-messages') {
    return handleNodeSessionMessagesRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-stream') {
    return handleNodeSessionStreamRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-input') {
    return handleNodeSessionInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-start') {
    return handleNodeSessionStartRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-attach') {
    return handleNodeSessionAttachRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-command') {
    return handleNodeSessionCommandRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-ack') {
    return handleNodeSessionAckRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-run-events') {
    return handleNodeSessionRunEventsRequest(ctx);
  }

  if (method === 'GET' && pathname === '/v0/node-rpc/session-artifact') {
    return handleNodeSessionArtifactRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-run-input') {
    return handleNodeSessionRunInputRequest(ctx);
  }

  if (method === 'POST' && pathname === '/v0/node-rpc/session-run-abort') {
    return handleNodeSessionRunAbortRequest(ctx);
  }

  writeNodeRpcNotFound(ctx);
  return true;
}

module.exports = {
  handleNodeRpcRequest
};
