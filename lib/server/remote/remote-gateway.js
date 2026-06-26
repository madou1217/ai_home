'use strict';

const { selectTransport } = require('./transport-selector');
const { readRemoteSecret } = require('./secret-store');
const { appendRemoteAuditEvent } = require('./audit-log');
const {
  consumeSseJsonStream,
  isAbortError
} = require('../sse-json-stream');

const DEFAULT_REMOTE_TIMEOUT_MS = 5000;

function splitPathAndSearch(value) {
  const withoutHash = String(value || '').trim().split('#')[0];
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) {
    return {
      pathname: withoutHash,
      search: ''
    };
  }
  return {
    pathname: withoutHash.slice(0, queryIndex),
    search: withoutHash.slice(queryIndex)
  };
}

function normalizeManagementPath(pathname) {
  const parsed = splitPathAndSearch(pathname);
  const path = parsed.pathname || '/v0/management/status';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeSearch(search) {
  const value = String(search || '').trim().split('#')[0];
  if (!value || value === '?') return '';
  return value.startsWith('?') ? value : `?${value}`;
}

function buildRemoteUrl(endpoint, pathname, search = '') {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const parsed = splitPathAndSearch(pathname);
  return `${base}${normalizeManagementPath(parsed.pathname)}${normalizeSearch(search || parsed.search)}`;
}

function createGatewayError(code, message, status = 502) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}

function buildGatewayResult(node, transport, result) {
  return {
    nodeId: node.id,
    transport: {
      id: transport.id,
      kind: transport.kind,
      endpoint: transport.endpoint
    },
    status: result.status,
    ok: result.ok,
    payload: result.payload
  };
}

function inferTransportPurpose(input = {}) {
  const explicit = String(input.transportPurpose || input.purpose || '').trim();
  if (explicit) return explicit;
  const rpc = String(input.rpc || '').toLowerCase();
  const scope = String(input.scope || '').toLowerCase();
  const pathname = String(input.pathname || '').toLowerCase();
  if (input.streamKind || /chat|session|tail|pty|stream/.test(rpc) || /chat|session|tail|pty|stream/.test(pathname)) {
    return 'stream';
  }
  if (/files?/.test(rpc) || /\/files?\//.test(pathname)) {
    return 'file';
  }
  if (scope.startsWith('runtime:') || /runtime|reload|restart|upgrade/.test(rpc) || /runtime|reload|restart|upgrade/.test(pathname)) {
    return 'runtime';
  }
  if (/bootstrap|join|invite/.test(rpc) || /bootstrap|join|invite/.test(pathname)) {
    return 'bootstrap';
  }
  if (/status|metrics/.test(rpc) || /status|metrics/.test(pathname)) {
    return 'status';
  }
  return 'read';
}

async function fetchRemoteJson(fetchImpl, url, options = {}) {
  const fetchFn = fetchImpl || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw createGatewayError('fetch_unavailable', 'fetch_unavailable', 500);
  }
  const response = await fetchFn(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = { ok: false, raw: text };
  }
  return {
    status: Number(response.status || 0),
    ok: Boolean(response.ok),
    payload
  };
}

async function fetchRemoteEventStream(fetchImpl, url, options = {}) {
  const fetchFn = fetchImpl || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw createGatewayError('fetch_unavailable', 'fetch_unavailable', 500);
  }
  return fetchFn(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    signal: options.signal
  });
}

function createAbortLinkedController(signal, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return { controller: null, cleanup: () => {} };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const abort = () => controller.abort();
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    controller,
    cleanup() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abort);
      }
    }
  };
}

async function requestRemoteManagement(input = {}, deps = {}) {
  const startedAt = Date.now();
  const node = input.node;
  const transports = Array.isArray(input.transports) ? input.transports : [];
  let transport = null;

  function writeAudit(patch = {}) {
    if (input.audit === false) return;
    appendRemoteAuditEvent({
      nodeId: node && node.id,
      rpc: input.rpc || input.pathname || '/v0/management/status',
      scope: input.scope || '',
      method: input.method || 'GET',
      pathname: input.pathname || '/v0/management/status',
      transportId: transport && transport.id,
      transportKind: transport && transport.kind,
      durationMs: Date.now() - startedAt,
      ...patch
    }, deps);
  }

  if (!node || node.disabled) {
    writeAudit({
      status: 404,
      ok: false,
      error: 'remote_node_unavailable'
    });
    throw createGatewayError('remote_node_unavailable', 'remote_node_unavailable', 404);
  }
  transport = input.transport || selectTransport(node, transports, {
    purpose: inferTransportPurpose(input)
  });
  if (!transport) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_unavailable'
    });
    throw createGatewayError('remote_transport_unavailable', 'remote_transport_unavailable', 503);
  }
  if (transport.kind === 'relay') {
    if (typeof deps.requestRelayManagement === 'function') {
      const result = await deps.requestRelayManagement({
        ...input,
        node,
        transport
      }, deps);
      writeAudit({
        status: result.status,
        ok: result.ok,
        error: result.ok ? '' : 'remote_relay_request_not_ok'
      });
      return buildGatewayResult(node, transport, result);
    }
    writeAudit({
      status: 501,
      ok: false,
      error: 'remote_relay_rpc_not_implemented'
    });
    throw createGatewayError('remote_relay_rpc_not_implemented', 'remote_relay_rpc_not_implemented', 501);
  }
  const url = buildRemoteUrl(transport.endpoint, input.pathname || '/v0/management/status');
  if (!url) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_endpoint_missing'
    });
    throw createGatewayError('remote_transport_endpoint_missing', 'remote_transport_endpoint_missing', 503);
  }
  const secret = readRemoteSecret(node.authRef, deps) || {};
  const headers = {};
  if (secret.managementKey) headers.authorization = `Bearer ${secret.managementKey}`;
  if (input.body !== undefined) headers['content-type'] = 'application/json';

  const timeoutMs = Math.max(1000, Number(input.timeoutMs || deps.timeoutMs) || DEFAULT_REMOTE_TIMEOUT_MS);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const result = await fetchRemoteJson(deps.fetchImpl, url, {
      method: input.method || 'GET',
      headers,
      body: input.body,
      signal: controller && controller.signal
    });
    writeAudit({
      status: result.status,
      ok: result.ok,
      error: result.ok ? '' : 'remote_request_not_ok'
    });
    return buildGatewayResult(node, transport, result);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      writeAudit({
        status: 504,
        ok: false,
        error: 'remote_request_timeout'
      });
      throw createGatewayError('remote_request_timeout', 'remote_request_timeout', 504);
    }
    writeAudit({
      status: 502,
      ok: false,
      error: 'remote_request_failed'
    });
    throw createGatewayError('remote_request_failed', String((error && error.message) || error || 'remote_request_failed'), 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamRemoteManagement(input = {}, handlers = {}, deps = {}) {
  const startedAt = Date.now();
  const node = input.node;
  const transports = Array.isArray(input.transports) ? input.transports : [];
  let transport = null;

  function writeAudit(patch = {}) {
    if (input.audit === false) return;
    appendRemoteAuditEvent({
      nodeId: node && node.id,
      rpc: input.rpc || input.pathname || '/v0/node-rpc/session-stream',
      scope: input.scope || '',
      method: input.method || 'GET',
      pathname: input.pathname || '/v0/node-rpc/session-stream',
      transportId: transport && transport.id,
      transportKind: transport && transport.kind,
      durationMs: Date.now() - startedAt,
      ...patch
    }, deps);
  }

  if (!node || node.disabled) {
    writeAudit({
      status: 404,
      ok: false,
      error: 'remote_node_unavailable'
    });
    throw createGatewayError('remote_node_unavailable', 'remote_node_unavailable', 404);
  }
  transport = input.transport || selectTransport(node, transports, {
    purpose: inferTransportPurpose({ ...input, streamKind: input.streamKind || 'session' })
  });
  if (!transport) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_unavailable'
    });
    throw createGatewayError('remote_transport_unavailable', 'remote_transport_unavailable', 503);
  }

  if (transport.kind === 'relay') {
    if (typeof deps.requestRelayManagementStream !== 'function') {
      writeAudit({
        status: 501,
        ok: false,
        error: 'remote_relay_stream_not_implemented'
      });
      throw createGatewayError('remote_relay_stream_not_implemented', 'remote_relay_stream_not_implemented', 501);
    }
    const result = await deps.requestRelayManagementStream({
      ...input,
      node,
      transport
    }, handlers, deps);
    writeAudit({
      status: result.status,
      ok: result.ok,
      error: result.ok ? '' : 'remote_relay_stream_not_ok'
    });
    return buildGatewayResult(node, transport, result);
  }

  const url = buildRemoteUrl(transport.endpoint, input.pathname || '/v0/node-rpc/session-stream');
  if (!url) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_endpoint_missing'
    });
    throw createGatewayError('remote_transport_endpoint_missing', 'remote_transport_endpoint_missing', 503);
  }

  const secret = readRemoteSecret(node.authRef, deps) || {};
  const headers = {};
  if (secret.managementKey) headers.authorization = `Bearer ${secret.managementKey}`;
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || deps.timeoutMs) || DEFAULT_REMOTE_TIMEOUT_MS);
  const linked = createAbortLinkedController(input.signal, timeoutMs);
  try {
    const response = await fetchRemoteEventStream(deps.fetchImpl, url, {
      method: input.method || 'GET',
      headers,
      signal: linked.controller && linked.controller.signal
    });
    const result = {
      status: Number(response.status || 0),
      ok: Boolean(response.ok)
    };
    if (!response.ok) {
      writeAudit({
        status: result.status,
        ok: false,
        error: 'remote_stream_not_ok'
      });
      return buildGatewayResult(node, transport, result);
    }
    if (typeof handlers.onOpen === 'function') {
      handlers.onOpen({
        type: 'remote.stream.opened',
        status: result.status,
        ok: true
      });
    }
    await consumeSseJsonStream(response, async (payload) => {
      if (typeof handlers.onChunk === 'function') handlers.onChunk(payload);
    }, {
      signal: linked.controller && linked.controller.signal
    });
    if (typeof handlers.onEnd === 'function') {
      handlers.onEnd({
        type: 'remote.stream.end',
        status: result.status,
        ok: true
      });
    }
    writeAudit({
      status: result.status,
      ok: true,
      error: ''
    });
    return buildGatewayResult(node, transport, result);
  } catch (error) {
    if (isAbortError(error)) {
      writeAudit({
        status: input.signal && input.signal.aborted ? 499 : 504,
        ok: false,
        error: input.signal && input.signal.aborted ? 'remote_stream_aborted' : 'remote_stream_timeout'
      });
      throw createGatewayError(
        input.signal && input.signal.aborted ? 'remote_stream_aborted' : 'remote_stream_timeout',
        input.signal && input.signal.aborted ? 'remote_stream_aborted' : 'remote_stream_timeout',
        input.signal && input.signal.aborted ? 499 : 504
      );
    }
    writeAudit({
      status: 502,
      ok: false,
      error: 'remote_stream_failed'
    });
    throw createGatewayError('remote_stream_failed', String((error && error.message) || error || 'remote_stream_failed'), 502);
  } finally {
    linked.cleanup();
  }
}

module.exports = {
  DEFAULT_REMOTE_TIMEOUT_MS,
  buildRemoteUrl,
  inferTransportPurpose,
  requestRemoteManagement,
  streamRemoteManagement
};
