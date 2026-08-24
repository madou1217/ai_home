'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');

const {
  createAccountWebSocket
} = require('../lib/server/account-websocket-egress');
const {
  createHttpConnectAgent
} = require('../lib/server/websocket-http-connect');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createConnectProxy(options = {}) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      client.removeListener('data', onData);
      const header = buffered.subarray(0, headerEnd).toString('latin1');
      requests.push(header);
      if (options.stall === true) return;
      const statusCode = Number(options.statusCode || 200);
      if (statusCode !== 200) {
        client.end(`HTTP/1.1 ${statusCode} Proxy Rejected\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      const match = /^CONNECT ([^:]+):(\d+) HTTP\/1\.1$/m.exec(header);
      if (!match) {
        client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      client.pause();
      const upstream = net.connect({ host: match[1], port: Number(match[2]) });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.once('connect', () => {
        const remainder = buffered.subarray(headerEnd + 4);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length > 0) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  server.forceClose = () => {
    for (const socket of sockets) socket.destroy();
  };
  return { server, requests };
}

function waitForWebSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

test('未绑定账号保持既有 WebSocket 网络选项，不注入代理连接器', async () => {
  let constructed = null;
  class FakeWebSocket {
    constructor(url, options) {
      constructed = { url, options };
    }
  }

  const socket = await createAccountWebSocket({
    provider: 'codex',
    account: { accountRef: ACCOUNT_REF },
    upstreamUrl: 'wss://upstream.example/responses',
    webSocketOptions: { headers: { Authorization: 'Bearer test-token' } },
    requestOptions: { proxyUrl: 'http://global-proxy.example:7890' }
  }, {
    WebSocket: FakeWebSocket,
    resolveAccountEgressRequestOptions: async (input) => ({
      ok: true,
      bound: false,
      options: input.options
    })
  });

  assert.equal(socket instanceof FakeWebSocket, true);
  assert.equal(constructed.url, 'wss://upstream.example/responses');
  assert.deepEqual(constructed.options.headers, { Authorization: 'Bearer test-token' });
  assert.equal(Object.hasOwn(constructed.options, 'agent'), false);
  assert.equal(Object.hasOwn(constructed.options, 'createConnection'), false);
});

test('绑定账号 WebSocket 经带 Basic auth 的本地 HTTP CONNECT 代理传输', async (t) => {
  const upstream = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  upstream.on('connection', (socket) => {
    socket.on('message', (message) => socket.send(message));
  });
  const proxy = createConnectProxy();
  const proxyAddress = await listen(proxy.server);
  t.after(async () => {
    proxy.server.forceClose();
    upstream.clients.forEach((socket) => socket.terminate());
    await Promise.all([closeServer(proxy.server), closeServer(upstream)]);
  });

  const upstreamUrl = `ws://127.0.0.1:${upstream.address().port}/responses`;
  const proxyUrl = `http://proxy-user:proxy-pass@127.0.0.1:${proxyAddress.port}`;
  const socket = await createAccountWebSocket({
    provider: 'codex',
    account: { accountRef: ACCOUNT_REF },
    upstreamUrl,
    webSocketOptions: { headers: { Authorization: 'Bearer test-token' } },
    requestOptions: {}
  }, {
    WebSocket,
    resolveAccountEgressRequestOptions: async (input) => ({
      ok: true,
      bound: true,
      options: { ...input.options, proxyUrl }
    })
  });
  await waitForWebSocketOpen(socket);
  socket.send('through-account-proxy');
  const [message] = await once(socket, 'message');

  assert.equal(message.toString(), 'through-account-proxy');
  assert.equal(proxy.requests.length, 1);
  assert.match(proxy.requests[0], new RegExp(`^CONNECT 127\\.0\\.0\\.1:${upstream.address().port} HTTP/1\\.1`, 'm'));
  assert.match(proxy.requests[0], /^Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz$/mi);
  socket.terminate();
});

test('WSS 在 CONNECT 成功后包装 TLS，并保留代理响应后的残余数据', async () => {
  const proxySocket = new EventEmitter();
  const secureSocket = new EventEmitter();
  const writes = [];
  const remainders = [];
  let tlsOptions = null;
  proxySocket.setNoDelay = () => {};
  proxySocket.setTimeout = () => {};
  proxySocket.destroy = () => {};
  proxySocket.unshift = (chunk) => remainders.push(chunk.toString());
  proxySocket.write = (chunk) => {
    writes.push(String(chunk));
    queueMicrotask(() => proxySocket.emit(
      'data',
      Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\nresidual-tls-bytes')
    ));
  };
  secureSocket.setTimeout = () => {};
  secureSocket.destroy = () => {};

  const agent = createHttpConnectAgent('http://127.0.0.1:23109', {
    secureTarget: true,
    netConnect(options) {
      assert.deepEqual(options, { host: '127.0.0.1', port: 23109 });
      queueMicrotask(() => proxySocket.emit('connect'));
      return proxySocket;
    },
    tlsConnect(options) {
      tlsOptions = options;
      queueMicrotask(() => secureSocket.emit('secureConnect'));
      return secureSocket;
    }
  });
  const connected = await new Promise((resolve, reject) => {
    agent.createConnection({
      host: 'api.example.com',
      port: 443,
      rejectUnauthorized: true
    }, (error, socket) => error ? reject(error) : resolve(socket));
  });

  assert.equal(connected, secureSocket);
  assert.match(writes[0], /^CONNECT api\.example\.com:443 HTTP\/1\.1/);
  assert.deepEqual(remainders, ['residual-tls-bytes']);
  assert.equal(tlsOptions.socket, proxySocket);
  assert.equal(tlsOptions.servername, 'api.example.com');
  assert.equal(tlsOptions.rejectUnauthorized, true);
  agent.destroy();
});

test('账号出口不可用时 WebSocket fail-closed，绝不构造直连连接', async () => {
  let constructorCalls = 0;
  class FakeWebSocket {
    constructor() {
      constructorCalls += 1;
    }
  }

  await assert.rejects(
    createAccountWebSocket({
      provider: 'codex',
      account: { accountRef: ACCOUNT_REF },
      upstreamUrl: 'wss://upstream.example/responses',
      webSocketOptions: {}
    }, {
      WebSocket: FakeWebSocket,
      resolveAccountEgressRequestOptions: async () => ({
        ok: false,
        bound: true,
        error: 'account_egress_unavailable',
        egressError: 'proxy_unreachable'
      })
    }),
    (error) => error?.code === 'account_egress_unavailable'
      && error?.egressError === 'proxy_unreachable'
  );
  assert.equal(constructorCalls, 0);
});

test('HTTP CONNECT 非 200 响应以明确错误终止 WebSocket，不回退直连', async (t) => {
  const proxy = createConnectProxy({ statusCode: 407 });
  const proxyAddress = await listen(proxy.server);
  t.after(async () => {
    proxy.server.forceClose();
    await closeServer(proxy.server);
  });

  const socket = await createAccountWebSocket({
    provider: 'codex',
    account: { accountRef: ACCOUNT_REF },
    upstreamUrl: 'ws://upstream.example/responses',
    webSocketOptions: {},
    connectTimeoutMs: 500
  }, {
    WebSocket,
    resolveAccountEgressRequestOptions: async () => ({
      ok: true,
      bound: true,
      options: { proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }
    })
  });
  const [error] = await once(socket, 'error');

  assert.equal(error.code, 'proxy_connect_rejected');
  assert.match(error.message, /407/);
  assert.equal(proxy.requests.length, 1);
});

test('HTTP CONNECT 响应超时会终止连接，不无限等待或回退直连', async (t) => {
  const proxy = createConnectProxy({ stall: true });
  const proxyAddress = await listen(proxy.server);
  t.after(async () => {
    proxy.server.forceClose();
    await closeServer(proxy.server);
  });

  const socket = await createAccountWebSocket({
    provider: 'codex',
    account: { accountRef: ACCOUNT_REF },
    upstreamUrl: 'ws://upstream.example/responses',
    webSocketOptions: {},
    connectTimeoutMs: 50
  }, {
    WebSocket,
    resolveAccountEgressRequestOptions: async () => ({
      ok: true,
      bound: true,
      options: { proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }
    })
  });
  const [error] = await once(socket, 'error');

  assert.equal(error.code, 'proxy_connect_timeout');
  assert.equal(proxy.requests.length, 1);
});
