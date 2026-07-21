'use strict';

const {
  FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
  MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES,
  isFabricGatewayWebSocketFrame,
  isFabricGatewayWebSocketOpenFrame,
  normalizeGatewayHop,
  pickFabricGatewayHeaders
} = require('../../../server/fabric-gateway-protocol');
const {
  safeWebSocketCloseCode,
  sendFabricGatewayWebSocketFrame
} = require('../../../server/fabric-gateway-websocket-frames');

function localWebSocketUrl(localUrl, pathname) {
  const target = new URL(String(pathname || '/v1/responses'), 'http://gateway.local');
  const base = new URL(`${String(localUrl || '').replace(/\/+$/, '')}/`);
  const local = new URL(target.pathname.replace(/^\/+/, ''), base);
  local.search = target.search;
  local.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return local.toString();
}

function localWebSocketHeaders(frame, options = {}) {
  const headers = pickFabricGatewayHeaders(frame.headers || {});
  const localClientKey = String(options.localClientKey || '').trim();
  if (localClientKey) headers.authorization = `Bearer ${localClientKey}`;
  headers['x-aih-gateway-hop'] = String(normalizeGatewayHop(frame.headers?.['x-aih-gateway-hop']));
  return headers;
}

function safeErrorCode(error, fallback) {
  const source = typeof error === 'string' ? error : error && error.code;
  const code = String(source || fallback || 'fabric_gateway_websocket_failed')
    .trim()
    .toLowerCase();
  return /^[a-z0-9_.:-]{1,96}$/.test(code) ? code : String(fallback || 'fabric_gateway_websocket_failed');
}

function createBrokerWebSocketHandler(options = {}, deps = {}) {
  const WebSocketClass = deps.WebSocket || require('ws');
  const active = new Map();

  function sendError(controlSocket, requestId, error) {
    sendFabricGatewayWebSocketFrame(controlSocket, {
      type: FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME,
      requestId,
      error: safeErrorCode(error)
    });
  }

  function removeEntry(entry) {
    if (active.get(entry.requestId) === entry) active.delete(entry.requestId);
  }

  function open(controlSocket, frame) {
    const requestId = String(frame.requestId || '').trim();
    if (!isFabricGatewayWebSocketOpenFrame(frame)) {
      sendError(controlSocket, requestId, 'fabric_gateway_websocket_open_rejected');
      return;
    }
    if (active.has(requestId)) {
      sendError(controlSocket, requestId, 'fabric_gateway_websocket_duplicate_request');
      return;
    }

    let localSocket;
    try {
      localSocket = new WebSocketClass(localWebSocketUrl(options.localUrl, frame.pathname), {
        headers: localWebSocketHeaders(frame, options)
      });
    } catch (error) {
      sendError(controlSocket, requestId, error);
      return;
    }
    const entry = { requestId, controlSocket, localSocket, opened: false };
    active.set(requestId, entry);

    localSocket.once('open', () => {
      entry.opened = true;
      sendFabricGatewayWebSocketFrame(controlSocket, {
        type: FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
        requestId
      });
    });
    localSocket.on('message', (data, isBinary) => {
      const body = Buffer.from(data || []);
      if (body.length > MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES || !sendFabricGatewayWebSocketFrame(controlSocket, {
        type: FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
        requestId,
        binary: Boolean(isBinary),
        bodyBase64: body.toString('base64')
      })) {
        localSocket.close(1011, 'gateway_backpressure');
      }
    });
    localSocket.once('error', (error) => {
      sendError(controlSocket, requestId, error);
    });
    localSocket.once('close', (code) => {
      removeEntry(entry);
      sendFabricGatewayWebSocketFrame(controlSocket, {
        type: FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME,
        requestId,
        code: safeWebSocketCloseCode(code, entry.opened ? 1000 : 1011)
      });
    });
  }

  function forwardData(frame) {
    const entry = active.get(String(frame.requestId || '').trim());
    if (!entry || entry.localSocket.readyState !== 1) return;
    const body = Buffer.from(String(frame.bodyBase64 || ''), 'base64');
    if (body.length > MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES) {
      entry.localSocket.close(1009, 'gateway_message_too_large');
      return;
    }
    entry.localSocket.send(body, { binary: frame.binary === true });
  }

  function close(frame) {
    const entry = active.get(String(frame.requestId || '').trim());
    if (!entry) return;
    entry.localSocket.close(safeWebSocketCloseCode(frame.code, 1000), 'gateway_closed');
  }

  const handler = (controlSocket, frame = {}) => {
    if (!isFabricGatewayWebSocketFrame(frame)) return false;
    if (frame.type === FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME) open(controlSocket, frame);
    else if (frame.type === FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME) forwardData(frame);
    else if (frame.type === FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME) close(frame);
    return true;
  };

  handler.close = async () => {
    const entries = Array.from(active.values());
    active.clear();
    entries.forEach((entry) => {
      try { entry.localSocket.terminate(); } catch (_error) {}
    });
  };
  return handler;
}

module.exports = {
  MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES,
  createBrokerWebSocketHandler,
  localWebSocketHeaders,
  localWebSocketUrl
};
