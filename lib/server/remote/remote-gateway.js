'use strict';

const { selectTransportDecision } = require('./transport-selector');
const { readRemoteSecret } = require('./secret-store');
const { appendRemoteAuditEvent } = require('./audit-log');
const {
  consumeSseJsonStream,
  isAbortError
} = require('../sse-json-stream');

const DEFAULT_REMOTE_TIMEOUT_MS = 5000;
const DEFAULT_WEBRTC_RECOVERY_TIMEOUT_MS = 6000;
const WEBRTC_FALLBACK_ERROR_CODES = new Set([
  'remote_webrtc_request_timeout',
  'remote_webrtc_send_failed',
  'remote_webrtc_session_closed',
  'remote_webrtc_session_error',
  'remote_webrtc_session_unavailable'
]);
const WEBRTC_RECOVERY_ERROR_CODES = new Set([
  'remote_webrtc_send_failed',
  'remote_webrtc_session_closed',
  'remote_webrtc_session_error',
  'remote_webrtc_session_unavailable'
]);

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

function createGatewayError(code, message, status = 502, details = null) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  if (details && typeof details === 'object') error.details = details;
  return error;
}

function attachTransportDecisionToError(error, decision, purpose = '') {
  const target = error instanceof Error
    ? error
    : createGatewayError('remote_request_failed', String(error || 'remote_request_failed'), 502);
  const details = target.details && typeof target.details === 'object' ? target.details : {};
  target.details = {
    ...details,
    transportDecision: serializeTransportDecision(decision, purpose)
  };
  return target;
}

function serializeTransportDecision(decision, purpose = '') {
  const source = decision && typeof decision === 'object' ? decision : {};
  return {
    transportPurpose: String(purpose || '').trim(),
    selectedTransportId: String(source.selectedTransportId || source.transport && source.transport.id || ''),
    selectedTransportKind: String(source.selectedKind || source.transport && source.transport.kind || ''),
    fallbackUsed: Boolean(source.fallbackUsed),
    fallbackFrom: Array.from(new Set((Array.isArray(source.fallbackFrom) ? source.fallbackFrom : [])
      .map((kind) => String(kind || '').trim())
      .filter(Boolean))),
    rejectedTransports: (Array.isArray(source.rejected) ? source.rejected : [])
      .map((item) => ({
        id: String(item && item.id || ''),
        kind: String(item && item.kind || ''),
        reason: String(item && item.reason || '')
      }))
      .filter((item) => item.id || item.kind || item.reason)
      .slice(0, 8)
  };
}

function createExplicitTransportDecision(transport) {
  return {
    transport,
    selected: transport,
    selectedTransportId: String(transport && transport.id || ''),
    selectedKind: String(transport && transport.kind || ''),
    fallbackUsed: false,
    fallbackFrom: [],
    rejected: []
  };
}

function isWebrtcFallbackError(error) {
  return WEBRTC_FALLBACK_ERROR_CODES.has(String(error && error.code || '').trim());
}

function isWebrtcRecoveryError(error) {
  return WEBRTC_RECOVERY_ERROR_CODES.has(String(error && error.code || '').trim());
}

function normalizeWebrtcRecoveryTimeoutMs(input = {}, deps = {}) {
  const value = input.webrtcRecoveryTimeoutMs !== undefined
    ? input.webrtcRecoveryTimeoutMs
    : deps.webrtcRecoveryTimeoutMs;
  const number = Number(value === undefined ? DEFAULT_WEBRTC_RECOVERY_TIMEOUT_MS : value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.max(250, Math.floor(number));
}

function shouldRecoverWebrtcForInput(input = {}, transportPurpose = '') {
  if (input.webrtcRecovery === false) return false;
  if (input.transport) return false;
  return String(transportPurpose || '').trim() === 'stream';
}

function decisionRejectedWebrtcFor(decision, reasons = []) {
  const reasonSet = new Set((Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => String(reason || '').trim())
    .filter(Boolean));
  return (Array.isArray(decision && decision.rejected) ? decision.rejected : [])
    .some((item) => String(item && item.kind || '') === 'webrtc'
      && (!reasonSet.size || reasonSet.has(String(item && item.reason || ''))));
}

async function waitForWebrtcRecovery(input, node, transportPurpose, deps = {}) {
  if (!shouldRecoverWebrtcForInput(input, transportPurpose)) return false;
  if (!node || typeof deps.waitForWebrtcManagementSession !== 'function') return false;
  const timeoutMs = normalizeWebrtcRecoveryTimeoutMs(input, deps);
  if (!timeoutMs) return false;
  try {
    return Boolean(await deps.waitForWebrtcManagementSession(node.id, { timeoutMs }, deps));
  } catch (_error) {
    return false;
  }
}

async function recoverWebrtcDecisionAfterWait(input, node, transports, transportPurpose, decision, deps = {}) {
  if (!decisionRejectedWebrtcFor(decision, 'webrtc_adapter_not_available')) return decision;
  const recovered = await waitForWebrtcRecovery(input, node, transportPurpose, deps);
  if (!recovered) return decision;
  const nextDecision = resolveTransportDecision(input, node, transports, transportPurpose, deps);
  return String(nextDecision && nextDecision.transport && nextDecision.transport.kind || '') === 'webrtc'
    ? nextDecision
    : decision;
}

function createWebrtcRuntimeFallbackDecision(decision, transports = [], failedTransport = null, reason = '') {
  const relay = transports.find((entry) => {
    if (String(entry && entry.kind || '') !== 'relay') return false;
    if (entry && entry.disabled) return false;
    return String(entry && entry.endpoint || '').trim();
  });
  if (!relay) return null;
  const failed = {
    id: String(failedTransport && failedTransport.id || ''),
    kind: String(failedTransport && failedTransport.kind || 'webrtc'),
    reason: String(reason || 'remote_webrtc_request_failed')
  };
  const rejected = [failed]
    .concat(Array.isArray(decision && decision.rejected) ? decision.rejected : [])
    .filter((item, index, items) => {
      const key = `${String(item && item.id || '')}:${String(item && item.kind || '')}:${String(item && item.reason || '')}`;
      return items.findIndex((entry) => (
        `${String(entry && entry.id || '')}:${String(entry && entry.kind || '')}:${String(entry && entry.reason || '')}` === key
      )) === index;
    });
  const fallbackFrom = Array.from(new Set((Array.isArray(decision && decision.fallbackFrom) ? decision.fallbackFrom : [])
    .concat('webrtc')
    .map((kind) => String(kind || '').trim())
    .filter(Boolean)));
  return {
    ...(decision || {}),
    transport: relay,
    selected: relay,
    selectedTransportId: String(relay.id || ''),
    selectedKind: String(relay.kind || ''),
    fallbackUsed: true,
    fallbackFrom,
    rejected
  };
}

function availableGatewayAdapters(deps = {}, node = null) {
  const webrtcAvailable = typeof deps.requestWebrtcManagement === 'function'
    && (typeof deps.hasWebrtcManagementSession !== 'function'
      || deps.hasWebrtcManagementSession(node && node.id, deps));
  return [
    webrtcAvailable ? 'webrtc' : '',
    typeof deps.requestWebtransportManagement === 'function' ? 'webtransport' : ''
  ].filter(Boolean);
}

function prepareGatewayTransports(transports = [], node = null, deps = {}) {
  const webrtcAvailable = typeof deps.requestWebrtcManagement === 'function'
    && (typeof deps.hasWebrtcManagementSession !== 'function'
      || deps.hasWebrtcManagementSession(node && node.id, deps));
  if (!webrtcAvailable) return transports;
  return transports.map((transport) => {
    if (String(transport && transport.kind || '') !== 'webrtc') return transport;
    return {
      ...transport,
      endpoint: String(transport.endpoint || '').trim() || `webrtc-session://${node && node.id || transport.nodeId || 'node'}`,
      status: 'up',
      score: Math.max(Number(transport.score) || 0, 90),
      lastError: ''
    };
  });
}

function resolveTransportDecision(input, node, transports, purpose, deps = {}) {
  if (input.transport) return createExplicitTransportDecision(input.transport);
  return selectTransportDecision(node, prepareGatewayTransports(transports, node, deps), {
    purpose,
    availableAdapters: availableGatewayAdapters(deps, node)
  });
}

function buildGatewayResult(node, transport, result, decision = null, purpose = '') {
  return {
    nodeId: node.id,
    transport: {
      id: transport.id,
      kind: transport.kind,
      endpoint: transport.endpoint
    },
    transportDecision: serializeTransportDecision(decision, purpose),
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
  const transportPurpose = inferTransportPurpose(input);
  let transportDecision = null;
  let transport = null;

  function writeAudit(patch = {}) {
    if (input.audit === false) return;
    const decision = serializeTransportDecision(transportDecision, transportPurpose);
    appendRemoteAuditEvent({
      nodeId: node && node.id,
      rpc: input.rpc || input.pathname || '/v0/management/status',
      scope: input.scope || '',
      method: input.method || 'GET',
      pathname: input.pathname || '/v0/management/status',
      transportId: transport && transport.id,
      transportKind: transport && transport.kind,
      transportPurpose: decision.transportPurpose,
      fallbackUsed: decision.fallbackUsed,
      fallbackFrom: decision.fallbackFrom,
      rejectedTransports: decision.rejectedTransports,
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
  transportDecision = resolveTransportDecision(input, node, transports, transportPurpose, deps);
  transportDecision = await recoverWebrtcDecisionAfterWait(
    input,
    node,
    transports,
    transportPurpose,
    transportDecision,
    deps
  );
  transport = transportDecision.transport;
  if (!transport) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_unavailable'
    });
    throw createGatewayError('remote_transport_unavailable', 'remote_transport_unavailable', 503, {
      transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
    });
  }
  if (transport.kind === 'relay') {
    if (typeof deps.requestRelayManagement === 'function') {
      try {
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
        return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
      } catch (error) {
        const enriched = attachTransportDecisionToError(error, transportDecision, transportPurpose);
        writeAudit({
          status: Number(enriched.status) || 502,
          ok: false,
          error: String(enriched.code || 'remote_relay_request_failed')
        });
        throw enriched;
      }
    }
    writeAudit({
      status: 501,
      ok: false,
      error: 'remote_relay_rpc_not_implemented'
    });
    throw createGatewayError('remote_relay_rpc_not_implemented', 'remote_relay_rpc_not_implemented', 501);
  }
  if (transport.kind === 'webrtc') {
    if (typeof deps.requestWebrtcManagement === 'function') {
      try {
        const result = await deps.requestWebrtcManagement({
          ...input,
          node,
          transport
        }, deps);
        writeAudit({
          status: result.status,
          ok: result.ok,
          error: result.ok ? '' : 'remote_webrtc_request_not_ok'
        });
        return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
      } catch (error) {
        if (isWebrtcRecoveryError(error) && await waitForWebrtcRecovery(input, node, transportPurpose, deps)) {
          transportDecision = resolveTransportDecision(input, node, transports, transportPurpose, deps);
          transport = transportDecision.transport;
          if (transport && transport.kind === 'webrtc') {
            try {
              const recoveredResult = await deps.requestWebrtcManagement({
                ...input,
                node,
                transport
              }, deps);
              writeAudit({
                status: recoveredResult.status,
                ok: recoveredResult.ok,
                error: recoveredResult.ok ? '' : 'remote_webrtc_request_not_ok'
              });
              return buildGatewayResult(node, transport, recoveredResult, transportDecision, transportPurpose);
            } catch (retryError) {
              error = retryError;
            }
          }
        }
        if (isWebrtcFallbackError(error) && typeof deps.requestRelayManagement === 'function') {
          const fallbackDecision = createWebrtcRuntimeFallbackDecision(
            transportDecision,
            transports,
            transport,
            error && error.code
          );
          if (fallbackDecision && fallbackDecision.transport) {
            transportDecision = fallbackDecision;
            transport = fallbackDecision.transport;
            try {
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
              return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
            } catch (relayError) {
              const enrichedRelay = attachTransportDecisionToError(relayError, transportDecision, transportPurpose);
              writeAudit({
                status: Number(enrichedRelay.status) || 502,
                ok: false,
                error: String(enrichedRelay.code || 'remote_relay_request_failed')
              });
              throw enrichedRelay;
            }
          }
        }
        const enriched = attachTransportDecisionToError(error, transportDecision, transportPurpose);
        writeAudit({
          status: Number(enriched.status) || 502,
          ok: false,
          error: String(enriched.code || 'remote_webrtc_request_failed')
        });
        throw enriched;
      }
    }
    writeAudit({
      status: 501,
      ok: false,
      error: 'remote_webrtc_rpc_not_implemented'
    });
    throw createGatewayError('remote_webrtc_rpc_not_implemented', 'remote_webrtc_rpc_not_implemented', 501, {
      transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
    });
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
    return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      writeAudit({
        status: 504,
        ok: false,
        error: 'remote_request_timeout'
      });
      throw createGatewayError('remote_request_timeout', 'remote_request_timeout', 504, {
        transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
      });
    }
    writeAudit({
      status: 502,
      ok: false,
      error: 'remote_request_failed'
    });
    throw createGatewayError('remote_request_failed', String((error && error.message) || error || 'remote_request_failed'), 502, {
      transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamRemoteManagement(input = {}, handlers = {}, deps = {}) {
  const startedAt = Date.now();
  const node = input.node;
  const transports = Array.isArray(input.transports) ? input.transports : [];
  const transportPurpose = inferTransportPurpose({ ...input, streamKind: input.streamKind || 'session' });
  let transportDecision = null;
  let transport = null;

  function writeAudit(patch = {}) {
    if (input.audit === false) return;
    const decision = serializeTransportDecision(transportDecision, transportPurpose);
    appendRemoteAuditEvent({
      nodeId: node && node.id,
      rpc: input.rpc || input.pathname || '/v0/node-rpc/session-stream',
      scope: input.scope || '',
      method: input.method || 'GET',
      pathname: input.pathname || '/v0/node-rpc/session-stream',
      transportId: transport && transport.id,
      transportKind: transport && transport.kind,
      transportPurpose: decision.transportPurpose,
      fallbackUsed: decision.fallbackUsed,
      fallbackFrom: decision.fallbackFrom,
      rejectedTransports: decision.rejectedTransports,
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
  transportDecision = resolveTransportDecision(input, node, transports, transportPurpose, deps);
  transportDecision = await recoverWebrtcDecisionAfterWait(
    input,
    node,
    transports,
    transportPurpose,
    transportDecision,
    deps
  );
  transport = transportDecision.transport;
  if (!transport) {
    writeAudit({
      status: 503,
      ok: false,
      error: 'remote_transport_unavailable'
    });
    throw createGatewayError('remote_transport_unavailable', 'remote_transport_unavailable', 503, {
      transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
    });
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
    try {
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
      return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
    } catch (error) {
      const enriched = attachTransportDecisionToError(error, transportDecision, transportPurpose);
      writeAudit({
        status: Number(enriched.status) || 502,
        ok: false,
        error: String(enriched.code || 'remote_relay_stream_failed')
      });
      throw enriched;
    }
  }
  if (transport.kind === 'webrtc') {
    if (typeof deps.requestWebrtcManagementStream !== 'function') {
      writeAudit({
        status: 501,
        ok: false,
        error: 'remote_webrtc_stream_not_implemented'
      });
      throw createGatewayError('remote_webrtc_stream_not_implemented', 'remote_webrtc_stream_not_implemented', 501, {
        transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
      });
    }
    try {
      const result = await deps.requestWebrtcManagementStream({
        ...input,
        node,
        transport
      }, handlers, deps);
      writeAudit({
        status: result.status,
        ok: result.ok,
        error: result.ok ? '' : 'remote_webrtc_stream_not_ok'
      });
      return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
    } catch (error) {
      if (isWebrtcRecoveryError(error) && await waitForWebrtcRecovery(input, node, transportPurpose, deps)) {
        transportDecision = resolveTransportDecision(input, node, transports, transportPurpose, deps);
        transport = transportDecision.transport;
        if (transport && transport.kind === 'webrtc') {
          try {
            const recoveredResult = await deps.requestWebrtcManagementStream({
              ...input,
              node,
              transport
            }, handlers, deps);
            writeAudit({
              status: recoveredResult.status,
              ok: recoveredResult.ok,
              error: recoveredResult.ok ? '' : 'remote_webrtc_stream_not_ok'
            });
            return buildGatewayResult(node, transport, recoveredResult, transportDecision, transportPurpose);
          } catch (retryError) {
            error = retryError;
          }
        }
      }
      if (isWebrtcFallbackError(error) && typeof deps.requestRelayManagementStream === 'function') {
        const fallbackDecision = createWebrtcRuntimeFallbackDecision(
          transportDecision,
          transports,
          transport,
          error && error.code
        );
        if (fallbackDecision && fallbackDecision.transport) {
          transportDecision = fallbackDecision;
          transport = fallbackDecision.transport;
          try {
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
            return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
          } catch (relayError) {
            const enrichedRelay = attachTransportDecisionToError(relayError, transportDecision, transportPurpose);
            writeAudit({
              status: Number(enrichedRelay.status) || 502,
              ok: false,
              error: String(enrichedRelay.code || 'remote_relay_stream_failed')
            });
            throw enrichedRelay;
          }
        }
      }
      const enriched = attachTransportDecisionToError(error, transportDecision, transportPurpose);
      writeAudit({
        status: Number(enriched.status) || 502,
        ok: false,
        error: String(enriched.code || 'remote_webrtc_stream_failed')
      });
      throw enriched;
    }
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
      return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
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
    return buildGatewayResult(node, transport, result, transportDecision, transportPurpose);
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
        input.signal && input.signal.aborted ? 499 : 504,
        {
          transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
        }
      );
    }
    writeAudit({
      status: 502,
      ok: false,
      error: 'remote_stream_failed'
    });
    throw createGatewayError('remote_stream_failed', String((error && error.message) || error || 'remote_stream_failed'), 502, {
      transportDecision: serializeTransportDecision(transportDecision, transportPurpose)
    });
  } finally {
    linked.cleanup();
  }
}

module.exports = {
  DEFAULT_REMOTE_TIMEOUT_MS,
  buildRemoteUrl,
  inferTransportPurpose,
  requestRemoteManagement,
  serializeTransportDecision,
  availableGatewayAdapters,
  streamRemoteManagement
};
