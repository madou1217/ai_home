'use strict';

const {
  FABRIC_GATEWAY_PROTOCOL_VERSION,
  FABRIC_GATEWAY_REQUEST_PURPOSE,
  FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
  MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES,
  pickFabricGatewayHeaders
} = require('./fabric-gateway-protocol');
const {
  parseFabricGatewayWebSocketFrame,
  safeWebSocketCloseCode,
  sendFabricGatewayWebSocketFrame
} = require('./fabric-gateway-websocket-frames');

const DEFAULT_FABRIC_GATEWAY_WEBSOCKET_OPEN_TIMEOUT_MS = 15_000;

function sessionError(code) {
  return Object.assign(new Error(code), { code });
}

function createFabricGatewayWebSocketSession(input = {}, deps = {}) {
  const controlSocket = deps.controlSocket;
  const releaseSlot = deps.releaseSlot;
  const WebSocketClass = deps.WebSocket || require('ws');
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  const requestId = String(input.requestId || '').trim();
  const pending = [];
  let pendingBytes = 0;
  let client = null;
  let gatewayServer = null;
  let finished = false;
  let openTimer = null;
  let resolveRemoteOpen;
  let rejectRemoteOpen;
  const remoteOpen = new Promise((resolve, reject) => {
    resolveRemoteOpen = resolve;
    rejectRemoteOpen = reject;
  });

  function notifyRemoteClose(code) {
    sendFabricGatewayWebSocketFrame(controlSocket, {
      type: FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
      requestId,
      code: safeWebSocketCloseCode(code, 1000)
    });
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (openTimer) cancelTimeout(openTimer);
    controlSocket.off('message', onControlMessage);
    controlSocket.off('close', onControlClose);
    controlSocket.off('error', onControlError);
    input.socket.off('close', onRawSocketClose);
    if (typeof releaseSlot === 'function') releaseSlot();
    if (gatewayServer) {
      try { gatewayServer.close(); } catch (_error) {}
    }
  }

  function fail(code, notifyRemote = true) {
    if (notifyRemote) notifyRemoteClose(1011);
    if (!client) rejectRemoteOpen(sessionError(code));
    else if (client.readyState === 1) client.close(1011, 'gateway_failed');
    finish();
  }

  function forwardRemoteData(frame) {
    const body = Buffer.from(String(frame.bodyBase64 || ''), 'base64');
    if (body.length > MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES) {
      fail('fabric_gateway_websocket_message_too_large');
      return;
    }
    if (client && client.readyState === 1) {
      client.send(body, { binary: frame.binary === true });
      return;
    }
    pendingBytes += body.length;
    if (pendingBytes > MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES) {
      fail('fabric_gateway_websocket_backpressure');
      return;
    }
    pending.push({ body, binary: frame.binary === true });
  }

  function onControlMessage(data) {
    const frame = parseFabricGatewayWebSocketFrame(data);
    if (!frame || frame.requestId !== requestId) return;
    if (frame.type === FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME) resolveRemoteOpen();
    else if (frame.type === FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME) forwardRemoteData(frame);
    else if (frame.type === FABRIC_GATEWAY_WEBSOCKET_CLOSED_FRAME) {
      if (!client) rejectRemoteOpen(sessionError('fabric_gateway_websocket_closed'));
      else if (client.readyState === 1) {
        client.close(safeWebSocketCloseCode(frame.code, 1000), 'gateway_closed');
      }
      finish();
    } else if (frame.type === FABRIC_GATEWAY_WEBSOCKET_ERROR_FRAME) {
      fail('fabric_gateway_websocket_remote_failed', false);
    }
  }

  function onControlClose() { fail('fabric_gateway_link_closed', false); }
  function onControlError() { fail('fabric_gateway_link_error', false); }
  function onRawSocketClose() {
    notifyRemoteClose(1000);
    fail('fabric_gateway_client_disconnected', false);
  }

  function attachLifecycle() {
    controlSocket.on('message', onControlMessage);
    controlSocket.once('close', onControlClose);
    controlSocket.once('error', onControlError);
    input.socket.once('close', onRawSocketClose);
    const timeoutMs = Math.max(
      1000,
      Number(deps.openTimeoutMs) || DEFAULT_FABRIC_GATEWAY_WEBSOCKET_OPEN_TIMEOUT_MS
    );
    openTimer = scheduleTimeout(() => fail('fabric_gateway_websocket_open_timeout'), timeoutMs);
    if (openTimer && typeof openTimer.unref === 'function') openTimer.unref();
  }

  function sendOpenFrame() {
    const headers = {
      ...pickFabricGatewayHeaders(input.req && input.req.headers),
      'x-provider': 'codex',
      'x-aih-gateway-hop': String(deps.gatewayHop)
    };
    return sendFabricGatewayWebSocketFrame(controlSocket, {
      type: FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
      purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
      gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
      requestId,
      pathname: input.pathname,
      headers
    });
  }

  function attachClient(webSocket) {
    client = webSocket;
    input.socket.off('close', onRawSocketClose);
    pending.splice(0).forEach((frame) => client.send(frame.body, { binary: frame.binary }));
    pendingBytes = 0;
    client.on('message', (data, isBinary) => {
      const body = Buffer.from(data || []);
      const sent = body.length <= MAX_FABRIC_GATEWAY_WEBSOCKET_MESSAGE_BYTES
        && sendFabricGatewayWebSocketFrame(controlSocket, {
          type: FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
          requestId,
          binary: Boolean(isBinary),
          bodyBase64: body.toString('base64')
        });
      if (!sent) client.close(1013, 'gateway_backpressure');
    });
    client.once('error', () => {
      notifyRemoteClose(1011);
      finish();
    });
    client.once('close', (code) => {
      notifyRemoteClose(code);
      finish();
    });
  }

  async function open() {
    attachLifecycle();
    if (!sendOpenFrame()) fail('fabric_gateway_send_failed', false);
    await remoteOpen;
    if (finished || input.socket.destroyed) throw sessionError('fabric_gateway_websocket_open_failed');
    cancelTimeout(openTimer);
    openTimer = null;
    gatewayServer = new WebSocketClass.Server({ noServer: true });
    try {
      gatewayServer.handleUpgrade(input.req, input.socket, input.head, attachClient);
    } catch (_error) {
      fail('fabric_gateway_websocket_client_upgrade_failed');
      throw sessionError('fabric_gateway_websocket_client_upgrade_failed');
    }
  }

  return { open };
}

module.exports = {
  DEFAULT_FABRIC_GATEWAY_WEBSOCKET_OPEN_TIMEOUT_MS,
  createFabricGatewayWebSocketSession
};
