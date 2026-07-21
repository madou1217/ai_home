'use strict';

const { normalizeId } = require('../../../server/remote/node-registry');
const { buildServerUrl } = require('../../../server/server-defaults');
const {
  WEBRTC_DATA_CHANNEL_LABEL,
  WEBRTC_NODE_CONNECT_PATH
} = require('../../../server/remote/webrtc-management-adapter');
const {
  fetchLocalRelayRequest,
  parseNodeRelayConnectArgs
} = require('./relay-client');
const {
  createAbortError,
  subscribeAbort,
  throwIfAborted,
  waitForAbortableDelay
} = require('../../../runtime/abortable');

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_REFRESH_MS = 25000;

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function resolveWebrtcManagementKey(options, serverConfig) {
  const key = String(options.managementKey || serverConfig.managementKey || '').trim();
  if (!key) {
    const error = new Error('management_key_required');
    error.code = 'management_key_required';
    error.command = 'webrtc-connect';
    throw error;
  }
  return key;
}

function normalizeWebrtcControlUrl(controlUrl, nodeIdInput) {
  const raw = String(controlUrl || '').trim();
  if (!raw) {
    const error = new Error('missing_webrtc_url');
    error.code = 'missing_webrtc_url';
    throw error;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_webrtc_url');
    error.code = 'invalid_webrtc_url';
    throw error;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    const error = new Error('invalid_webrtc_url');
    error.code = 'invalid_webrtc_url';
    throw error;
  }

  const nodeId = normalizeId(nodeIdInput || url.searchParams.get('nodeId'));
  if (!nodeId) {
    const error = new Error('missing_webrtc_node_id');
    error.code = 'missing_webrtc_node_id';
    throw error;
  }

  url.protocol = url.protocol === 'ws:' ? 'http:' : (url.protocol === 'wss:' ? 'https:' : url.protocol);
  url.pathname = WEBRTC_NODE_CONNECT_PATH;
  url.search = '';
  url.searchParams.set('nodeId', nodeId);
  return { url, nodeId };
}

function getWebrtcRuntime(deps = {}) {
  if (deps.RTCPeerConnection) return { RTCPeerConnection: deps.RTCPeerConnection };
  return require('werift');
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function sendChannelJson(channel, payload) {
  if (!channel || String(channel.readyState || '').toLowerCase() !== 'open') return false;
  channel.send(JSON.stringify(payload));
  return true;
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

function waitForChannelOpen(channel, timeoutMs, signal) {
  if (channel && String(channel.readyState || '').toLowerCase() === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('webrtc_channel_open_timeout');
      error.code = 'webrtc_channel_open_timeout';
      reject(error);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    let stateSubscription = null;
    let unsubscribeAbort = () => {};
    function cleanup() {
      clearTimeout(timer);
      unsubscribeAbort();
      if (channel && typeof channel.off === 'function') {
        channel.off('open', onOpen);
        channel.off('close', onClose);
        channel.off('error', onError);
      }
      if (stateSubscription && typeof stateSubscription.unSubscribe === 'function') {
        stateSubscription.unSubscribe();
      }
    }
    function onOpen() {
      cleanup();
      resolve();
    }
    function onClose() {
      cleanup();
      const error = new Error('webrtc_channel_closed');
      error.code = 'webrtc_channel_closed';
      reject(error);
    }
    function onError() {
      cleanup();
      const error = new Error('webrtc_channel_error');
      error.code = 'webrtc_channel_error';
      reject(error);
    }
    function onAbort() {
      cleanup();
      reject(createAbortError());
    }
    if (channel && typeof channel.once === 'function') {
      channel.once('open', onOpen);
      channel.once('close', onClose);
      channel.once('error', onError);
    }
    if (channel && channel.stateChanged && typeof channel.stateChanged.subscribe === 'function') {
      stateSubscription = channel.stateChanged.subscribe((state) => {
        const text = String(state || channel.readyState || '').toLowerCase();
        if (text === 'open') onOpen();
        if (text === 'closed') onClose();
      });
    }
    unsubscribeAbort = subscribeAbort(signal, onAbort);
  });
}

function waitForChannelClose(channel) {
  return new Promise((resolve) => {
    if (!channel || String(channel.readyState || '').toLowerCase() === 'closed') {
      resolve();
      return;
    }
    if (typeof channel.once === 'function') {
      channel.once('close', resolve);
      channel.once('error', resolve);
      return;
    }
    setTimeout(resolve, 1000);
  });
}

async function respondToWebrtcRequest(channel, frame, request, deps = {}) {
  let result = null;
  try {
    result = await fetchLocalRelayRequest(frame, request, deps);
  } catch (_error) {
    result = {
      status: 502,
      ok: false,
      payload: { ok: false, error: 'webrtc_local_request_failed' }
    };
  }
  sendChannelJson(channel, {
    type: 'relay.response',
    requestId: String(frame.requestId || ''),
    status: result.status,
    ok: result.ok,
    payload: result.payload
  });
}

function attachWebrtcRequestHandler(channel, request, deps = {}) {
  const unsubscribe = subscribeChannelMessage(channel, (data) => {
    const frame = parseJsonMessage(data);
    if (!frame || frame.type !== 'relay.request' || !frame.requestId) return;
    respondToWebrtcRequest(channel, frame, request, deps);
  });
  if (channel && typeof channel.once === 'function') {
    channel.once('close', unsubscribe);
    channel.once('error', unsubscribe);
  }
  return unsubscribe;
}

async function postWebrtcOffer(request, offer, deps = {}) {
  const fetchFn = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    const error = new Error('fetch_unavailable');
    error.code = 'fetch_unavailable';
    throw error;
  }
  const response = await fetchFn(request.url.toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${request.managementKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ offer }),
    signal: deps.signal
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!response.ok || !payload || !payload.ok) {
    const error = new Error(payload && payload.error || `webrtc_connect_http_${response.status}`);
    error.code = payload && payload.error || 'webrtc_connect_rejected';
    error.statusCode = response.status;
    throw error;
  }
  return payload.result || {};
}

function buildWebrtcRequest(options, deps = {}) {
  const serverConfig = readServerConfigSafe(deps.readServerConfig);
  const normalized = normalizeWebrtcControlUrl(options.controlUrl, options.nodeId);
  return {
    url: normalized.url,
    nodeId: normalized.nodeId,
    managementKey: resolveWebrtcManagementKey(options, serverConfig),
    localBaseUrl: buildServerUrl(serverConfig, ''),
    connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    reconnectDelayMs: options.reconnectDelayMs || DEFAULT_RECONNECT_DELAY_MS,
    refreshMs: options.heartbeatMs || DEFAULT_REFRESH_MS,
    maxAttempts: options.maxAttempts,
    once: Boolean(options.once)
  };
}

function serializeWebrtcConnection(request, answer, attempts) {
  return {
    ok: true,
    nodeId: request.nodeId,
    webrtcUrl: request.url.toString(),
    sessionId: String(answer && answer.sessionId || ''),
    transportId: String(answer && answer.transportId || ''),
    attempts
  };
}

async function connectWebrtcOnce(request, deps = {}) {
  const signal = deps.signal;
  throwIfAborted(signal);
  const runtime = getWebrtcRuntime(deps);
  const peerConnection = new runtime.RTCPeerConnection(deps.webRtcConfig || { iceServers: [] });
  const channel = peerConnection.createDataChannel(WEBRTC_DATA_CHANNEL_LABEL);
  const connection = { peerConnection, channel };
  const unsubscribeAbort = subscribeAbort(signal, () => closeWebrtcConnection(connection));
  try {
    attachWebrtcRequestHandler(channel, request, deps);
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    const answer = await postWebrtcOffer(request, peerConnection.localDescription, deps);
    await peerConnection.setRemoteDescription(answer.answer);
    await waitForChannelOpen(channel, request.connectTimeoutMs, signal);
    if (request.once) closeWebrtcConnection(connection);
    return {
      ...connection,
      answer
    };
  } catch (error) {
    closeWebrtcConnection(connection);
    throw error;
  } finally {
    unsubscribeAbort();
  }
}

function isRetryableWebrtcConnectError(error) {
  const code = String(error && error.code || '');
  if ([
    'management_key_required',
    'missing_webrtc_url',
    'invalid_webrtc_url',
    'missing_webrtc_node_id'
  ].includes(code)) {
    return false;
  }
  const statusCode = Number(error && error.statusCode) || 0;
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return false;
  }
  return true;
}

function closeWebrtcConnection(connection = {}) {
  const channel = connection.channel;
  const peerConnection = connection.peerConnection;
  try {
    if (channel && typeof channel.close === 'function') channel.close();
  } catch (_error) {}
  try {
    if (peerConnection && typeof peerConnection.close === 'function') peerConnection.close();
  } catch (_error) {}
}

function waitForWebrtcReconnectWindow(connection = {}, request = {}, signal) {
  const channel = connection.channel;
  const peerConnection = connection.peerConnection;
  const refreshMs = Math.max(1000, Number(request.refreshMs) || DEFAULT_REFRESH_MS);
  return new Promise((resolve) => {
    let done = false;
    let channelStateSubscription = null;
    let peerStateSubscription = null;
    let unsubscribeAbort = () => {};
    const timer = setTimeout(() => finish('webrtc_refresh_interval'), refreshMs);

    function cleanup() {
      clearTimeout(timer);
      unsubscribeAbort();
      if (channel && typeof channel.off === 'function') {
        channel.off('close', onChannelClose);
        channel.off('error', onChannelError);
      }
      if (channelStateSubscription && typeof channelStateSubscription.unSubscribe === 'function') {
        channelStateSubscription.unSubscribe();
      }
      if (peerStateSubscription && typeof peerStateSubscription.unSubscribe === 'function') {
        peerStateSubscription.unSubscribe();
      }
    }
    function finish(reason) {
      if (done) return;
      done = true;
      cleanup();
      resolve(reason);
    }
    function onChannelClose() {
      finish('webrtc_channel_closed');
    }
    function onChannelError() {
      finish('webrtc_channel_error');
    }
    if (!channel || String(channel.readyState || '').toLowerCase() === 'closed') {
      finish('webrtc_channel_closed');
      return;
    }
    if (channel && typeof channel.once === 'function') {
      channel.once('close', onChannelClose);
      channel.once('error', onChannelError);
    }
    if (channel && channel.stateChanged && typeof channel.stateChanged.subscribe === 'function') {
      channelStateSubscription = channel.stateChanged.subscribe((state) => {
        if (String(state || channel.readyState || '').toLowerCase() === 'closed') onChannelClose();
      });
    }
    if (peerConnection && peerConnection.connectionStateChange && typeof peerConnection.connectionStateChange.subscribe === 'function') {
      peerStateSubscription = peerConnection.connectionStateChange.subscribe((state) => {
        const text = String(state || '').toLowerCase();
        if (text === 'closed' || text === 'failed' || text === 'disconnected') {
          finish(`webrtc_peer_${text}`);
        }
      });
    }
    unsubscribeAbort = subscribeAbort(signal, () => finish('webrtc_aborted'));
  });
}

async function runWebrtcLoop(request, deps = {}) {
  let attempts = 0;
  let lastResult = null;
  const signal = deps.signal;
  const connectOnce = typeof deps.connectWebrtcOnce === 'function' ? deps.connectWebrtcOnce : connectWebrtcOnce;
  const sleep = deps.sleep || waitForAbortableDelay;
  while ((!request.maxAttempts || attempts < request.maxAttempts) && !(signal && signal.aborted)) {
    attempts += 1;
    let connection;
    try {
      connection = await connectOnce(request, deps);
    } catch (error) {
      if (signal && signal.aborted) break;
      if (!isRetryableWebrtcConnectError(error) || (request.maxAttempts && attempts >= request.maxAttempts)) {
        throw error;
      }
      await sleep(request.reconnectDelayMs, { signal });
      continue;
    }
    lastResult = serializeWebrtcConnection(request, connection.answer, attempts);
    await waitForWebrtcReconnectWindow(connection, request, signal);
    closeWebrtcConnection(connection);
    if (signal && signal.aborted) break;
    if (request.maxAttempts && attempts >= request.maxAttempts) break;
    await sleep(request.reconnectDelayMs, { signal });
  }
  return lastResult || {
    ok: false,
    nodeId: request.nodeId,
    webrtcUrl: request.url.toString(),
    sessionId: '',
    transportId: '',
    attempts
  };
}

async function runNodeWebrtcConnect(rawArgs = [], deps = {}) {
  const options = parseNodeRelayConnectArgs(rawArgs);
  const request = buildWebrtcRequest(options, deps);
  if (request.once) {
    const connection = await connectWebrtcOnce(request, deps);
    return {
      ...serializeWebrtcConnection(request, connection.answer, 1),
      json: Boolean(options.json),
      once: true
    };
  }
  const result = await runWebrtcLoop(request, deps);
  return {
    ...result,
    json: Boolean(options.json),
    once: false
  };
}

module.exports = {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REFRESH_MS,
  DEFAULT_RECONNECT_DELAY_MS,
  attachWebrtcRequestHandler,
  buildWebrtcRequest,
  closeWebrtcConnection,
  connectWebrtcOnce,
  normalizeWebrtcControlUrl,
  runNodeWebrtcConnect,
  runWebrtcLoop,
  waitForWebrtcReconnectWindow
};
