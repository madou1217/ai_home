const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  buildWebrtcRequest,
  runWebrtcLoop
} = require('../lib/cli/services/node/webrtc-client');

function createFakeConnection(sessionId) {
  const channel = new EventEmitter();
  channel.readyState = 'open';
  channel.closed = false;
  channel.close = () => {
    channel.closed = true;
    channel.readyState = 'closed';
    channel.emit('close');
  };
  const peerConnection = {
    closed: false,
    close() {
      this.closed = true;
    }
  };
  return {
    channel,
    peerConnection,
    answer: {
      sessionId,
      transportId: 'node-a-webrtc'
    }
  };
}

test('buildWebrtcRequest reuses relay heartbeat as WebRTC refresh interval', () => {
  const request = buildWebrtcRequest({
    controlUrl: 'http://control.example.com',
    nodeId: 'node-a',
    heartbeatMs: 1234
  }, {
    readServerConfig: () => ({ managementKey: 'node-secret' })
  });

  assert.equal(request.refreshMs, 1234);
});

test('runWebrtcLoop refreshes stale-open sessions and reconnects', async () => {
  const connections = [];
  const result = await runWebrtcLoop({
    url: new URL('http://control.example.com/v0/fabric/webrtc/node/connect?nodeId=node-a'),
    nodeId: 'node-a',
    managementKey: 'node-secret',
    refreshMs: 5,
    reconnectDelayMs: 1,
    maxAttempts: 2
  }, {
    connectWebrtcOnce: async () => {
      const connection = createFakeConnection(`session-${connections.length + 1}`);
      connections.push(connection);
      return connection;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-2');
  assert.equal(result.attempts, 2);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].channel.closed, true);
  assert.equal(connections[0].peerConnection.closed, true);
  assert.equal(connections[1].channel.closed, true);
  assert.equal(connections[1].peerConnection.closed, true);
});

test('runWebrtcLoop retries transient connect failures before succeeding', async () => {
  let attempts = 0;
  const result = await runWebrtcLoop({
    url: new URL('http://control.example.com/v0/fabric/webrtc/node/connect?nodeId=node-a'),
    nodeId: 'node-a',
    managementKey: 'node-secret',
    refreshMs: 5,
    reconnectDelayMs: 1,
    maxAttempts: 2
  }, {
    connectWebrtcOnce: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('connect ECONNREFUSED');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return createFakeConnection('session-1');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.transportId, 'node-a-webrtc');
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
});

test('runWebrtcLoop fails fast for non-retryable auth errors', async () => {
  let attempts = 0;
  await assert.rejects(
    () => runWebrtcLoop({
      url: new URL('http://control.example.com/v0/fabric/webrtc/node/connect?nodeId=node-a'),
      nodeId: 'node-a',
      managementKey: 'bad-secret',
      refreshMs: 5,
      reconnectDelayMs: 1,
      maxAttempts: 0
    }, {
      connectWebrtcOnce: async () => {
        attempts += 1;
        const error = new Error('webrtc_connect_http_401');
        error.code = 'webrtc_connect_rejected';
        error.statusCode = 401;
        throw error;
      }
    }),
    { code: 'webrtc_connect_rejected' }
  );
  assert.equal(attempts, 1);
});
