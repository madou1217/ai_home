'use strict';

const FABRIC_GATEWAY_REQUEST_PURPOSE = 'gateway-fallback';
const FABRIC_GATEWAY_PROTOCOL_VERSION = 1;
const MAX_FABRIC_GATEWAY_HOPS = 1;
const FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME = 'broker.gateway.websocket.open';
const FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME = 'broker.gateway.websocket.opened';
const FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME = 'broker.gateway.websocket.data';
const FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME = 'broker.gateway.websocket.close';
const FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME = 'broker.gateway.websocket.closed';
const FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME = 'broker.gateway.websocket.error';
const MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES = 10 * 1024 * 1024;
const FABRIC_GATEWAY_WEBSOCKET_FRAME_TYPES = new Set([
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME
]);
const FABRIC_GATEWAY_FORWARD_HEADERS = Object.freeze([
  'accept',
  'content-type',
  'last-event-id',
  'x-aih-request-id',
  'x-provider',
  'x-session-id',
  'x-conversation-id',
  'x-thread-id',
  'openai-session-id',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta'
]);

function normalizeGatewayHop(value) {
  const hop = Number(value);
  return Number.isInteger(hop) && hop >= 0 ? hop : 0;
}

function pickFabricGatewayHeaders(headers = {}) {
  return FABRIC_GATEWAY_FORWARD_HEADERS.reduce((selected, name) => {
    const value = headers[name];
    if (value !== undefined) {
      selected[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return selected;
  }, {});
}

function isFabricGatewayRouteAllowed(method, pathname) {
  const requestMethod = String(method || 'GET').trim().toUpperCase();
  if (!['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(requestMethod)) {
    return false;
  }
  try {
    const url = new URL(String(pathname || ''), 'http://gateway.local');
    return url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v1beta/');
  } catch (_error) {
    return false;
  }
}

function isFabricGatewayWebSocketRouteAllowed(pathname) {
  try {
    const url = new URL(String(pathname || ''), 'http://gateway.local');
    return url.pathname === '/v1/responses';
  } catch (_error) {
    return false;
  }
}

function isFabricGatewayWebSocketFrame(frame) {
  return Boolean(
    frame
    && FABRIC_GATEWAY_WEBSOCKET_FRAME_TYPES.has(frame.type)
    && String(frame.requestId || '').trim()
  );
}

function isFabricGatewayWebSocketOpenFrame(frame) {
  const hop = normalizeGatewayHop(frame?.headers?.['x-aih-gateway-hop']);
  return Boolean(
    isFabricGatewayWebSocketFrame(frame)
    && frame.type === FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME
    && frame.purpose === FABRIC_GATEWAY_REQUEST_PURPOSE
    && Number(frame.gatewayProtocolVersion) === FABRIC_GATEWAY_PROTOCOL_VERSION
    && hop > 0
    && hop <= MAX_FABRIC_GATEWAY_HOPS
    && isFabricGatewayWebSocketRouteAllowed(frame.pathname)
  );
}

function isFabricGatewayFrame(frame) {
  const hop = normalizeGatewayHop(frame?.headers?.['x-aih-gateway-hop']);
  return Boolean(
    frame
    && frame.purpose === FABRIC_GATEWAY_REQUEST_PURPOSE
    && Number(frame.gatewayProtocolVersion) === FABRIC_GATEWAY_PROTOCOL_VERSION
    && hop > 0
    && hop <= MAX_FABRIC_GATEWAY_HOPS
    && isFabricGatewayRouteAllowed(frame.method, frame.pathname)
  );
}

module.exports = {
  FABRIC_GATEWAY_PROTOCOL_VERSION,
  FABRIC_GATEWAY_REQUEST_PURPOSE,
  FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
  MAX_FABRIC_GATEWAY_HOPS,
  MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES,
  isFabricGatewayFrame,
  isFabricGatewayRouteAllowed,
  isFabricGatewayWebSocketFrame,
  isFabricGatewayWebSocketOpenFrame,
  isFabricGatewayWebSocketRouteAllowed,
  normalizeGatewayHop,
  pickFabricGatewayHeaders
};
