'use strict';

const {
  isFabricBrokerRouteAllowed,
  pickForwardHeaders,
  pickResponseHeaders
} = require('../../../server/fabric-broker-router');
const {
  isFabricGatewayFrame,
  normalizeGatewayHop,
  pickFabricGatewayHeaders
} = require('../../../server/fabric-gateway-protocol');

const MAX_BROKER_CHUNK_BYTES = 256 * 1024;

function sendFrame(socket, frame) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (_error) {
    return false;
  }
}

function localRequestUrl(localUrl, pathname) {
  const target = new URL(String(pathname || '/'), 'http://broker.local');
  const base = new URL(`${String(localUrl || '').replace(/\/+$/, '')}/`);
  const local = new URL(target.pathname.replace(/^\/+/, ''), base);
  local.search = target.search;
  return local.toString();
}

function collectResponseHeaders(response) {
  const headers = {};
  if (response && response.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value, name) => {
      headers[String(name).toLowerCase()] = value;
    });
  }
  return pickResponseHeaders(headers);
}

function sendChunk(socket, requestId, sequence, value) {
  const buffer = Buffer.from(value || []);
  let nextSequence = sequence;
  for (let offset = 0; offset < buffer.length; offset += MAX_BROKER_CHUNK_BYTES) {
    const chunk = buffer.subarray(offset, offset + MAX_BROKER_CHUNK_BYTES);
    sendFrame(socket, {
      type: 'broker.response.chunk',
      requestId,
      sequence: nextSequence,
      bodyBase64: chunk.toString('base64')
    });
    nextSequence += 1;
  }
  return nextSequence;
}

async function streamResponseBody(socket, requestId, response) {
  let sequence = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      sequence = sendChunk(socket, requestId, sequence, next.value);
    }
    return;
  }
  if (typeof response.arrayBuffer !== 'function') return;
  const buffer = Buffer.from(await response.arrayBuffer());
  sendChunk(socket, requestId, sequence, buffer);
}

function errorBodyBase64(code) {
  return Buffer.from(JSON.stringify({ ok: false, error: code })).toString('base64');
}

function localRequestHeaders(frame, options = {}) {
  if (!isFabricGatewayFrame(frame)) return pickForwardHeaders(frame.headers || {});
  const headers = pickFabricGatewayHeaders(frame.headers || {});
  const localClientKey = String(options.localClientKey || '').trim();
  if (localClientKey) headers.authorization = `Bearer ${localClientKey}`;
  headers['x-aih-gateway-hop'] = String(normalizeGatewayHop(frame.headers?.['x-aih-gateway-hop']));
  return headers;
}

function createBrokerRequestHandler(options = {}, deps = {}) {
  const activeRequests = new Map();
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;

  async function execute(socket, frame, entry) {
    const method = String(frame.method || 'GET').trim().toUpperCase();
    const pathname = String(frame.pathname || '/').trim();
    const requestId = String(frame.requestId || '').trim();
    let responseStarted = false;

    try {
      if (!isFabricBrokerRouteAllowed(method, pathname) && !isFabricGatewayFrame(frame)) {
        sendFrame(socket, {
          type: 'broker.response',
          requestId,
          ok: false,
          status: 403,
          headers: { 'content-type': 'application/json' },
          bodyBase64: errorBodyBase64('fabric_broker_local_route_not_allowed')
        });
        return;
      }
      if (typeof fetchImpl !== 'function') {
        sendFrame(socket, {
          type: 'broker.response',
          requestId,
          ok: false,
          status: 500,
          headers: { 'content-type': 'application/json' },
          bodyBase64: errorBodyBase64('fabric_broker_fetch_unavailable')
        });
        return;
      }

      const body = frame.bodyBase64 ? Buffer.from(String(frame.bodyBase64), 'base64') : undefined;
      const response = await fetchImpl(localRequestUrl(options.localUrl, pathname), {
        method,
        headers: localRequestHeaders(frame, options),
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: entry.controller.signal
      });
      cancelTimeout(entry.timer);
      entry.timer = null;
      if (entry.cancelled) return;
      sendFrame(socket, {
        type: 'broker.response.start',
        requestId,
        ok: response.ok,
        status: response.status,
        headers: collectResponseHeaders(response)
      });
      responseStarted = true;
      await streamResponseBody(socket, requestId, response);
      if (entry.cancelled) return;
      sendFrame(socket, { type: 'broker.response.end', requestId });
    } catch (error) {
      if (entry.cancelled) return;
      const code = entry.timedOut
        ? 'fabric_broker_local_request_timeout'
        : String((error && error.code) || 'fabric_broker_local_request_failed');
      if (responseStarted) {
        sendFrame(socket, { type: 'broker.response.error', requestId, error: code });
        return;
      }
      sendFrame(socket, {
        type: 'broker.response',
        requestId,
        ok: false,
        status: entry.timedOut ? 504 : 502,
        headers: { 'content-type': 'application/json' },
        bodyBase64: errorBodyBase64(code)
      });
    }
  }

  async function handleRequest(socket, frame) {
    const requestId = String(frame.requestId || '').trim();
    if (!requestId) return;
    const controller = new AbortController();
    const entry = {
      controller,
      cancelled: false,
      timedOut: false,
      done: null,
      timer: null
    };
    const timeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || 30_000);
    entry.timer = scheduleTimeout(() => {
      entry.timedOut = true;
      controller.abort('fabric_broker_local_request_timeout');
    }, timeoutMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    activeRequests.set(requestId, entry);
    entry.done = execute(socket, frame, entry).finally(() => {
      if (entry.timer) cancelTimeout(entry.timer);
      if (activeRequests.get(requestId) === entry) activeRequests.delete(requestId);
    });
    return entry.done;
  }

  async function handleCancel(frame) {
    const requestId = String(frame.requestId || '').trim();
    const entry = activeRequests.get(requestId);
    if (!entry) return;
    entry.cancelled = true;
    entry.controller.abort('broker_client_cancelled');
    await entry.done;
  }

  const handler = (socket, frame = {}) => {
    if (frame.type === 'broker.request.cancel') return handleCancel(frame);
    if (frame.type !== 'broker.request') return Promise.resolve();
    return handleRequest(socket, frame);
  };

  handler.close = async () => {
    const pending = Array.from(activeRequests.values());
    pending.forEach((entry) => {
      entry.cancelled = true;
      entry.controller.abort('broker_link_closed');
    });
    await Promise.allSettled(pending.map((entry) => entry.done));
  };
  return handler;
}

module.exports = {
  createBrokerRequestHandler,
  localRequestHeaders,
  localRequestUrl
};
