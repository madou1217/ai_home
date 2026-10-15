'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { createRelayPortMux } = require('../lib/server/relay-port-mux');

/**
 * AIH 端口分流：同一个端口上 HTTP 与 SOCKS5 共存（中转跟随 AIH 端口的关键件）。
 * 这些用例用真实 socket：HTTP 要照旧可用（keep-alive 也要），SOCKS5 要认证、要按用户名转到内核。
 */

const PASSWORD = 'secret-pass';

/** 极简假内核：只认免认证握手，然后把收到的字节回显（够验证「转到内核」与「管道」）。 */
function startFakeKernel() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        assert.equal(chunk[0], 0x05, '内核收到的是 SOCKS5 问候');
        socket.write(Buffer.from([0x05, 0x00]));
        socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('KERNEL:'), data])));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`http:${req.method}:${req.url}`);
    });
    resolve(server);
  });
}

async function withMux(run) {
  const kernel = await startFakeKernel();
  const httpServer = await startHttpServer();
  const mux = createRelayPortMux({
    httpServer,
    resolveRelay: () => ({
      enabled: true,
      password: PASSWORD,
      portForUser: (username) => (username === 'n_known' ? kernel.port : 0)
    })
  });
  const listener = mux.listener();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  try {
    return await run({ port });
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    await new Promise((resolve) => kernel.server.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

/** 用 http.request 走这个端口：证明非 SOCKS5 连接被原样交回 HTTP。 */
function httpGet(port, path, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 完整走一次 SOCKS5 认证握手；返回服务端的方法选择与认证结果。 */
function socksHandshake(port, { username, password, methods = [0x00, 0x02] } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const result = { method: null, auth: null };
    socket.setTimeout(3000);
    socket.once('error', () => resolve({ ...result, error: 'error' }));
    socket.once('timeout', () => resolve({ ...result, error: 'timeout' }));
    socket.once('connect', () => {
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    let stage = 'greeting';
    socket.on('data', (chunk) => {
      if (stage === 'greeting') {
        result.method = chunk[1];
        if (chunk[1] !== 0x02) {
          socket.destroy();
          resolve(result);
          return;
        }
        stage = 'auth';
        const user = Buffer.from(username || '');
        const pass = Buffer.from(password || '');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        return;
      }
      if (stage === 'auth') {
        result.auth = chunk[1];
        if (chunk[1] !== 0x00) {
          socket.destroy();
          resolve(result);
          return;
        }
        // 认证过了：发一个 CONNECT，看内核回显（证明管道打通）。
        stage = 'connect';
        const host = Buffer.from('example.com');
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x00, 0x50])
        ]));
        return;
      }
      socket.destroy();
      resolve({ ...result, echoed: chunk.toString('utf8') });
    });
  });
}

test('the AIH port keeps serving HTTP and keep-alive while also accepting SOCKS5', async () => {
  await withMux(async ({ port }) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      assert.deepEqual(await httpGet(port, '/readyz', agent), { status: 200, body: 'http:GET:/readyz' });
      // 同一条连接上的第二个请求：交接没有破坏 keep-alive。
      assert.deepEqual(await httpGet(port, '/v0/webui/accounts', agent), { status: 200, body: 'http:GET:/v0/webui/accounts' });
    } finally {
      agent.destroy();
    }
    // 同一个端口上再来一条 SOCKS5：认证通过 → 转到内核（假内核把 CONNECT 回显回来）。
    const handshake = await socksHandshake(port, { username: 'n_known', password: PASSWORD });
    assert.deepEqual([handshake.method, handshake.auth], [0x02, 0x00]);
    assert.match(handshake.echoed, /^KERNEL:/);
    // 转完之后 HTTP 依旧可用。
    assert.deepEqual(await httpGet(port, '/again'), { status: 200, body: 'http:GET:/again' });
  });
});

test('the port mux rejects a bad password, an unknown node and a no-auth-only client', async () => {
  await withMux(async ({ port }) => {
    const wrongPassword = await socksHandshake(port, { username: 'n_known', password: 'nope' });
    assert.deepEqual([wrongPassword.method, wrongPassword.auth], [0x02, 0x01]);

    const unknownNode = await socksHandshake(port, { username: 'n_missing', password: PASSWORD });
    assert.deepEqual([unknownNode.method, unknownNode.auth], [0x02, 0x01]);

    // 只提供免认证的客户端：这个入口必须认证（用户名就是节点选择器）。
    const noAuth = await socksHandshake(port, { methods: [0x00] });
    assert.equal(noAuth.method, 0xff);
  });
});

test('the port mux stays out of the way when the relay uses dedicated ports', async () => {
  const httpServer = await startHttpServer();
  const mux = createRelayPortMux({
    httpServer,
    resolveRelay: () => ({ enabled: false, password: '', portForUser: () => 0 })
  });
  assert.equal(mux.enabled(), false);
  await new Promise((resolve) => httpServer.close(resolve));
});
