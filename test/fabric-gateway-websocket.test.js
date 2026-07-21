'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME
} = require('../lib/server/fabric-gateway-protocol');
const {
  createFabricGatewayWebSocketSession
} = require('../lib/server/fabric-gateway-websocket-session');
const {
  proxyFabricGatewayWebSocket
} = require('../lib/server/fabric-gateway-websocket');

function fakeControlSocket() {
  const frames = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    frames,
    send(value) { frames.push(JSON.parse(value)); }
  });
}

function fakeRawSocket() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    write() {},
    destroy() { this.destroyed = true; }
  });
}

function fakeWebSocketRuntime(client) {
  return {
    Server: class {
      handleUpgrade(_req, _socket, _head, accept) { accept(client); }
      close() {}
    }
  };
}

test('fabric gateway websocket session multiplexes data and releases capacity on close', async () => {
  const controlSocket = fakeControlSocket();
  const rawSocket = fakeRawSocket();
  const clientMessages = [];
  const client = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(data, options) { clientMessages.push({ data: Buffer.from(data), options }); },
    close() { this.readyState = 3; }
  });
  let releases = 0;
  const session = createFabricGatewayWebSocketSession({
    req: {
      headers: { authorization: 'Bearer public-secret', 'x-session-id': 'session-1' }
    },
    socket: rawSocket,
    head: Buffer.alloc(0),
    requestId: 'request-1',
    pathname: '/v1/responses'
  }, {
    WebSocket: fakeWebSocketRuntime(client),
    controlSocket,
    gatewayHop: 1,
    releaseSlot() { releases += 1; }
  });

  const opening = session.open();
  assert.equal(controlSocket.frames[0].type, FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME);
  assert.equal(controlSocket.frames[0].headers.authorization, undefined);
  assert.equal(controlSocket.frames[0].headers['x-session-id'], 'session-1');
  controlSocket.emit('message', JSON.stringify({
    type: FABRIC_GATEWAY_WEBSOCKET_OPENED_FRAME,
    requestId: 'request-1'
  }));
  await opening;

  client.emit('message', Buffer.from('ping'), false);
  const outgoing = controlSocket.frames.find((frame) => frame.type === FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME);
  assert.equal(Buffer.from(outgoing.bodyBase64, 'base64').toString(), 'ping');
  controlSocket.emit('message', JSON.stringify({
    type: FABRIC_GATEWAY_WEBSOCKET_DATA_FRAME,
    requestId: 'request-1',
    binary: false,
    bodyBase64: Buffer.from('pong').toString('base64')
  }));
  assert.equal(clientMessages[0].data.toString(), 'pong');

  client.emit('close', 1000);
  assert.equal(controlSocket.frames.at(-1).type, FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME);
  assert.equal(releases, 1);
});

test('fabric gateway websocket session fails closed on open timeout', async () => {
  const controlSocket = fakeControlSocket();
  let timeoutCallback = null;
  let releases = 0;
  const session = createFabricGatewayWebSocketSession({
    req: { headers: {} },
    socket: fakeRawSocket(),
    head: Buffer.alloc(0),
    requestId: 'request-timeout',
    pathname: '/v1/responses'
  }, {
    WebSocket: fakeWebSocketRuntime(new EventEmitter()),
    controlSocket,
    gatewayHop: 1,
    setTimeout(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeout() {},
    releaseSlot() { releases += 1; }
  });

  const opening = session.open();
  timeoutCallback();
  await assert.rejects(opening, (error) => error.code === 'fabric_gateway_websocket_open_timeout');
  assert.equal(controlSocket.frames.at(-1).type, FABRIC_GATEWAY_WEBSOCKET_CLOSE_FRAME);
  assert.equal(releases, 1);
});

test('fabric gateway websocket does not intercept local-account or second-hop upgrades', async () => {
  const localAccount = await proxyFabricGatewayWebSocket({
    state: { accounts: { codex: [{ accessToken: 'token' }] } },
    req: { headers: {} }
  });
  const secondHop = await proxyFabricGatewayWebSocket({
    state: { accounts: {} },
    req: { headers: { 'x-aih-gateway-hop': '1' } }
  });

  assert.equal(localAccount, false);
  assert.equal(secondHop, false);
});
