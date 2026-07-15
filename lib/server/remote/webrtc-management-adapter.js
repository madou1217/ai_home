'use strict';

const {
  authorizeRelayNode,
  createRelayRequestId,
  isRelayManagementRequestAllowed,
  normalizeRelayRequestPath
} = require('./relay-server');
const {
  listNodeTransports,
  upsertRemoteTransport
} = require('./transport-registry');
const {
  createWebrtcSessionRegistry,
  isWebrtcChannelOpen
} = require('./webrtc-session-registry');

const WEBRTC_NODE_CONNECT_PATH = '/v0/fabric/webrtc/node/connect';
const DEFAULT_WEBRTC_TRANSPORT_SCORE = 88;
const DEFAULT_WEBRTC_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_WEBRTC_RECOVERY_TIMEOUT_MS = 6000;
const DEFAULT_WEBRTC_RECOVERY_POLL_MS = 100;
const DEFAULT_WEBRTC_PROMOTION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WEBRTC_PROMOTION_MIN_VALID_MS = 12 * 60 * 60 * 1000;
const DEFAULT_WEBRTC_PROMOTION_MODE = 'management-datachannel';
const DEFAULT_WEBRTC_RPC_PROMOTION_MODE = 'management-rpc';
const DEFAULT_WEBRTC_PROMOTION_EVIDENCE_REF = 'runtime:webrtc-management-datachannel';
const DEFAULT_WEBRTC_RPC_PROMOTION_EVIDENCE_REF = 'runtime:webrtc-management-rpc';
const WEBRTC_DATA_CHANNEL_LABEL = 'aih.rpc.v1';
const sharedWebrtcSessionRegistry = createWebrtcSessionRegistry();

function loadWerift(deps = {}) {
  if (deps.RTCPeerConnection) return { RTCPeerConnection: deps.RTCPeerConnection };
  try {
    return require('werift');
  } catch (_error) {
    return null;
  }
}

function createWebrtcRequestError(code, status = 502) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function sendChannelJson(channel, payload) {
  if (!isWebrtcChannelOpen(channel)) return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch (_error) {
    return false;
  }
}

function subscribeChannelMessage(channel, onMessage) {
  if (channel && channel.onMessage && typeof channel.onMessage.subscribe === 'function') {
    const subscription = channel.onMessage.subscribe(onMessage);
    return () => {
      if (subscription && typeof subscription.unSubscribe === 'function') subscription.unSubscribe();
    };
  }
  if (channel && typeof channel.on === 'function' && typeof channel.off === 'function') {
    channel.on('message', onMessage);
    return () => channel.off('message', onMessage);
  }
  return () => {};
}

function waitForWebrtcResponse(channel, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(createWebrtcRequestError('remote_webrtc_request_timeout', 504));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    const unsubscribe = subscribeChannelMessage(channel, (data) => {
      const message = parseJsonMessage(data);
      if (!message || message.type !== 'relay.response' || message.requestId !== requestId) return;
      cleanup();
      resolve(message);
    });

    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
      if (channel && typeof channel.off === 'function') {
        channel.off('close', onClose);
        channel.off('error', onError);
      }
    }
    function onClose() {
      cleanup();
      reject(createWebrtcRequestError('remote_webrtc_session_closed', 503));
    }
    function onError() {
      cleanup();
      reject(createWebrtcRequestError('remote_webrtc_session_error', 503));
    }

    if (channel && typeof channel.once === 'function') {
      channel.once('close', onClose);
      channel.once('error', onError);
    }
  });
}

function upsertWebrtcTransport(nodeId, patch = {}, deps = {}) {
  return upsertRemoteTransport({
    id: `${nodeId}-webrtc`,
    nodeId,
    kind: 'webrtc',
    endpoint: patch.endpoint,
    provider: 'webrtc',
    managedBy: 'aih',
    routeRole: 'data-plane',
    trustLevel: 'managed',
    ...patch
  }, deps);
}

function getNowMs(deps = {}) {
  const now = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  return Number.isFinite(Number(now)) ? Math.max(0, Math.floor(Number(now))) : Date.now();
}

function normalizePositiveMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1000, Math.floor(number));
}

function currentWebrtcPromotion(nodeId, deps = {}) {
  const transports = listNodeTransports(nodeId, deps);
  const transport = transports.find((entry) => String(entry && entry.kind || '') === 'webrtc') || null;
  return transport && transport.promotion && typeof transport.promotion === 'object'
    ? transport.promotion
    : null;
}

function isWebrtcPromotionExpiringSoon(promotion, deps = {}) {
  const expiresAt = Number(promotion && promotion.expiresAt || 0);
  if (!expiresAt) return true;
  const minValidMs = normalizePositiveMs(deps.webrtcPromotionMinValidMs, DEFAULT_WEBRTC_PROMOTION_MIN_VALID_MS);
  return expiresAt - getNowMs(deps) <= minValidMs;
}

function shouldPreserveWebrtcPromotion(existingPromotion, desiredPromotion = {}, deps = {}) {
  if (!existingPromotion || existingPromotion.remoteRequestReady !== true) return false;
  const existingMode = String(existingPromotion.mode || '').trim();
  const desiredMode = String(desiredPromotion && desiredPromotion.mode || '').trim();
  if (
    existingMode === DEFAULT_WEBRTC_RPC_PROMOTION_MODE
    && desiredMode === DEFAULT_WEBRTC_PROMOTION_MODE
    && !isWebrtcPromotionExpiringSoon(existingPromotion, deps)
  ) {
    return true;
  }
  return false;
}

function shouldRefreshWebrtcPromotion(nodeId, deps = {}, desiredPromotion = {}) {
  const promotion = currentWebrtcPromotion(nodeId, deps);
  if (!promotion || promotion.remoteRequestReady !== true) return true;
  const desiredMode = String(desiredPromotion && desiredPromotion.mode || '').trim();
  if (shouldPreserveWebrtcPromotion(promotion, desiredPromotion, deps)) {
    return false;
  }
  const expiresSoon = isWebrtcPromotionExpiringSoon(promotion, deps);
  if (desiredMode && String(promotion.mode || '') !== desiredMode) return true;
  return expiresSoon;
}

function buildWebrtcPromotion(input = {}, deps = {}) {
  const now = getNowMs(deps);
  const ttlMs = normalizePositiveMs(deps.webrtcPromotionTtlMs, DEFAULT_WEBRTC_PROMOTION_TTL_MS);
  return {
    remoteRequestReady: true,
    mode: String(input.mode || DEFAULT_WEBRTC_PROMOTION_MODE).trim().slice(0, 64),
    evidenceRef: String(input.evidenceRef || DEFAULT_WEBRTC_PROMOTION_EVIDENCE_REF).trim().slice(0, 256),
    rttP95Ms: Math.max(0, Number(input.rttP95Ms || 0) || 0),
    rpcP95Ms: Math.max(0, Number(input.rpcP95Ms || 0) || 0),
    promotedAt: now,
    expiresAt: now + ttlMs
  };
}

function maybeRefreshWebrtcPromotion(nodeId, patch = {}, deps = {}) {
  if (deps.webrtcPromotionRefresh === false) return null;
  const desiredPromotion = patch.promotion || {};
  const promotion = currentWebrtcPromotion(nodeId, deps);
  if (shouldPreserveWebrtcPromotion(promotion, desiredPromotion, deps)) return null;
  if (!shouldRefreshWebrtcPromotion(nodeId, deps, desiredPromotion)) return null;
  return upsertWebrtcTransport(nodeId, {
    endpoint: patch.endpoint,
    status: patch.status || 'up',
    score: patch.score === undefined ? DEFAULT_WEBRTC_TRANSPORT_SCORE : patch.score,
    latencyMs: patch.latencyMs === undefined ? 0 : patch.latencyMs,
    lastError: patch.lastError === undefined ? '' : patch.lastError,
    promotion: buildWebrtcPromotion(desiredPromotion, deps)
  }, deps);
}

function attachWebrtcSessionLifecycle(input = {}) {
  const {
    node,
    transport,
    session,
    registry,
    deps,
    endpoint
  } = input;
  const channel = session.channel;
  const peerConnection = session.peerConnection;

  function markUp() {
    registry.touchWebrtcSession(session.sessionId);
    const patch = {
      endpoint,
      status: 'up',
      score: DEFAULT_WEBRTC_TRANSPORT_SCORE,
      latencyMs: 0,
      lastError: ''
    };
    upsertWebrtcTransport(node.id, patch, deps);
    maybeRefreshWebrtcPromotion(node.id, {
      ...patch,
      promotion: {
        mode: DEFAULT_WEBRTC_PROMOTION_MODE,
        evidenceRef: DEFAULT_WEBRTC_PROMOTION_EVIDENCE_REF
      }
    }, deps);
  }

  function markDisconnected(errorCode) {
    const current = registry.getWebrtcSession(node.id);
    if (!current || current.sessionId !== session.sessionId) return;
    registry.removeWebrtcSession(session.sessionId);
    upsertWebrtcTransport(node.id, {
      endpoint,
      status: 'degraded',
      score: 0,
      latencyMs: 0,
      lastError: errorCode || 'webrtc_disconnected'
    }, deps);
  }

  function markUpIfOpen() {
    if (isWebrtcChannelOpen(channel)) markUp();
  }

  markUpIfOpen();
  [50, 250, 1000].forEach((delayMs) => {
    const timer = setTimeout(markUpIfOpen, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  if (channel && channel.stateChanged && typeof channel.stateChanged.subscribe === 'function') {
    channel.stateChanged.subscribe((state) => {
      if (String(channel.readyState || state || '').toLowerCase() === 'open') markUp();
      if (String(state || '').toLowerCase() === 'closed') markDisconnected('webrtc_channel_closed');
    });
  }
  if (channel && typeof channel.on === 'function') {
    channel.once('open', markUp);
    channel.once('close', () => markDisconnected('webrtc_channel_closed'));
    channel.once('error', () => markDisconnected('webrtc_channel_error'));
  }
  if (peerConnection && peerConnection.connectionStateChange && typeof peerConnection.connectionStateChange.subscribe === 'function') {
    peerConnection.connectionStateChange.subscribe((state) => {
      const text = String(state || '').toLowerCase();
      if (text === 'connected') markUp();
      if (text === 'closed' || text === 'failed' || text === 'disconnected') {
        markDisconnected(`webrtc_peer_${text}`);
      }
    });
  }

  return transport;
}

async function answerWebrtcNodeConnection(input = {}, deps = {}) {
  const authorization = authorizeRelayNode(input.req || {}, deps);
  if (!authorization.ok) {
    const error = createWebrtcRequestError(authorization.error, authorization.statusCode);
    error.authorization = authorization;
    throw error;
  }
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const offer = payload.offer && typeof payload.offer === 'object' ? payload.offer : payload;
  if (offer.type !== 'offer' || !String(offer.sdp || '').trim()) {
    throw createWebrtcRequestError('invalid_webrtc_offer', 400);
  }

  const runtime = loadWerift(deps);
  if (!runtime || typeof runtime.RTCPeerConnection !== 'function') {
    throw createWebrtcRequestError('webrtc_runtime_unavailable', 500);
  }

  const node = authorization.node;
  const endpoint = String(input.endpoint || '').trim();
  const registry = deps.webrtcSessionRegistry || sharedWebrtcSessionRegistry;
  const sessionId = createRelayRequestId();
  const peerConnection = new runtime.RTCPeerConnection(deps.webRtcConfig || { iceServers: [] });
  const transport = upsertWebrtcTransport(node.id, {
    endpoint,
    status: 'degraded',
    score: 0,
    latencyMs: 0,
    lastError: 'webrtc_connecting'
  }, deps);

  peerConnection.onDataChannel.subscribe((channel) => {
    const label = String(channel && channel.label || '').trim();
    if (label && label !== WEBRTC_DATA_CHANNEL_LABEL) return;
    const session = registry.registerWebrtcSession({
      sessionId,
      nodeId: node.id,
      transportId: transport.id,
      peerConnection,
      channel,
      remoteAddress: String(input.remoteAddress || '').trim()
    });
    attachWebrtcSessionLifecycle({
      node,
      transport,
      session,
      registry,
      deps,
      endpoint
    });
  });

  await peerConnection.setRemoteDescription(offer);
  await peerConnection.setLocalDescription(await peerConnection.createAnswer());

  return {
    ok: true,
    nodeId: node.id,
    sessionId,
    transportId: transport.id,
    answer: peerConnection.localDescription
  };
}

function hasWebrtcManagementSession(nodeId, deps = {}) {
  const registry = deps.webrtcSessionRegistry || sharedWebrtcSessionRegistry;
  return registry.hasOpenWebrtcSession(nodeId);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForWebrtcManagementSession(nodeId, options = {}, deps = {}) {
  const registry = deps.webrtcSessionRegistry || sharedWebrtcSessionRegistry;
  if (registry.hasOpenWebrtcSession(nodeId)) return true;
  const timeoutMs = normalizePositiveMs(options.timeoutMs, DEFAULT_WEBRTC_RECOVERY_TIMEOUT_MS);
  const intervalMs = normalizePositiveMs(options.intervalMs, DEFAULT_WEBRTC_RECOVERY_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    if (registry.hasOpenWebrtcSession(nodeId)) return true;
  }
  return registry.hasOpenWebrtcSession(nodeId);
}

async function requestWebrtcManagement(input = {}, deps = {}) {
  const node = input.node;
  const registry = deps.webrtcSessionRegistry || sharedWebrtcSessionRegistry;
  const session = registry.getWebrtcSession(node && node.id);
  const channel = session && session.channel;
  if (!session || !isWebrtcChannelOpen(channel)) {
    throw createWebrtcRequestError('remote_webrtc_session_unavailable', 503);
  }
  upsertWebrtcTransport(node.id, {
    endpoint: input.transport && input.transport.endpoint || 'http://127.0.0.1',
    status: 'up',
    score: DEFAULT_WEBRTC_TRANSPORT_SCORE,
    latencyMs: 0,
    lastError: ''
  }, deps);

  const method = String(input.method || 'GET').toUpperCase();
  const pathname = normalizeRelayRequestPath(input.pathname || '/v0/management/status');
  if (!isRelayManagementRequestAllowed(method, pathname)) {
    throw createWebrtcRequestError('remote_webrtc_route_not_allowed', 403);
  }

  const requestId = createRelayRequestId();
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || deps.timeoutMs) || DEFAULT_WEBRTC_REQUEST_TIMEOUT_MS);
  const startedAt = getNowMs(deps);
  const responsePromise = waitForWebrtcResponse(channel, requestId, timeoutMs);
  if (!sendChannelJson(channel, {
    type: 'relay.request',
    requestId,
    method,
    pathname,
    body: input.body
  })) {
    throw createWebrtcRequestError('remote_webrtc_send_failed', 503);
  }
  const response = await responsePromise;
  registry.touchWebrtcSession(session.sessionId);
  if (response && response.ok) {
    maybeRefreshWebrtcPromotion(node.id, {
      endpoint: input.transport && input.transport.endpoint || 'http://127.0.0.1',
      promotion: {
        mode: DEFAULT_WEBRTC_RPC_PROMOTION_MODE,
        evidenceRef: `${DEFAULT_WEBRTC_RPC_PROMOTION_EVIDENCE_REF}:${pathname}`,
        rpcP95Ms: Math.max(0, getNowMs(deps) - startedAt)
      }
    }, deps);
  }
  return {
    status: Number(response.status || 0),
    ok: Boolean(response.ok),
    payload: response.payload == null ? null : response.payload
  };
}

module.exports = {
  WEBRTC_DATA_CHANNEL_LABEL,
  WEBRTC_NODE_CONNECT_PATH,
  answerWebrtcNodeConnection,
  buildWebrtcPromotion,
  hasWebrtcManagementSession,
  maybeRefreshWebrtcPromotion,
  requestWebrtcManagement,
  shouldRefreshWebrtcPromotion,
  waitForWebrtcManagementSession,
  upsertWebrtcTransport
};
