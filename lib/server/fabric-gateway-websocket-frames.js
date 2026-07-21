'use strict';

const {
  MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES
} = require('./fabric-gateway-protocol');

function parseFabricGatewayWebSocketFrame(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function sendFabricGatewayWebSocketFrame(socket, frame) {
  if (!socket || socket.readyState !== 1) return false;
  if (Number(socket.bufferedAmount || 0) > MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (_error) {
    return false;
  }
}

function safeWebSocketCloseCode(value, fallback = 1011) {
  const code = Number(value);
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return fallback;
}

module.exports = {
  parseFabricGatewayWebSocketFrame,
  safeWebSocketCloseCode,
  sendFabricGatewayWebSocketFrame
};
