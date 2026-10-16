'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { createRelayPortMux } = require('../lib/server/relay-port-mux');
const { createRelayUdpFront } = require('../lib/server/relay-udp-front');

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
    // 停服顺序与生产一致：先排空在途（这里没有），再让分流器销毁它接管的连接，
    // 否则 listener.close() 要等 keep-alive 客户端自己断开（实测 3s）。
    mux.destroyConnections();
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

/** 极简假边车（UDP 版）：TCP 上回答 ASSOCIATE，并给一个原样回显封装数据报的 UDP 中继。 */
function startFakeUdpSidecar() {
  return new Promise((resolve) => {
    const udp = dgram.createSocket('udp4');
    udp.on('message', (message, rinfo) => {
      try { udp.send(message, rinfo.port, rinfo.address); } catch (_error) { /* 关停竞态 */ }
    });
    udp.bind(0, '127.0.0.1', () => {
      const requestServer = net.createServer((socket) => {
        socket.once('data', () => {
          socket.write(Buffer.from([0x05, 0x00]));
          socket.once('data', () => {
            const port = udp.address().port;
            socket.write(Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1]),
              Buffer.from([(port >> 8) & 0xff, port & 0xff])
            ]));
          });
        });
      });
      requestServer.listen(0, '127.0.0.1', () => resolve({ udp, requestServer, port: requestServer.address().port }));
    });
  });
}

/** 客户端侧：认证 + UDP ASSOCIATE，返回改写过后的 BND 与那条控制连接。 */
function associate(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let stage = 'greeting';
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
    socket.on('data', (chunk) => {
      if (stage === 'greeting') {
        stage = 'auth';
        const user = Buffer.from('n_known');
        const pass = Buffer.from(PASSWORD);
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        return;
      }
      if (stage === 'auth') {
        assert.equal(chunk[1], 0x00, '认证必须通过');
        stage = 'associate';
        socket.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      assert.equal(chunk[1], 0x00, 'ASSOCIATE 必须成功');
      const bindHost = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
      resolve({ socket, bindHost, bindPort: chunk.readUInt16BE(8) });
    });
  });
}

function udpEcho(host, port, payload) {
  return new Promise((resolve) => {
    const udp = dgram.createSocket('udp4');
    const done = (value) => {
      clearTimeout(timer);
      try { udp.close(); } catch (_error) { /* 已经关了 */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 3000);
    udp.once('message', (message) => done(message));
    udp.send(payload, port, host, () => undefined);
  });
}

test('UDP ASSOCIATE is terminated on the AIH port and datagrams are bridged to the kernel', async () => {
  const sidecar = await startFakeUdpSidecar();
  const httpServer = await startHttpServer();
  // 生产里前端绑的是 AIH 的端口号；测试用临时端口。
  const front = createRelayUdpFront({ port: 0, host: '127.0.0.1' });
  await front.start();
  const mux = createRelayPortMux({
    httpServer,
    resolveUdpFront: () => front,
    resolveRelay: () => ({ enabled: true, password: PASSWORD, portForUser: () => sidecar.port })
  });
  const listener = mux.listener();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const muxPort = listener.address().port;
  try {
    const client = await associate(muxPort);
    // 关键：给客户端的 BND 是**我们的固定 UDP 端口**（不是边车那个临时端口）。
    assert.equal(client.bindPort, front.port());
    assert.notEqual(client.bindPort, sidecar.udp.address().port);
    assert.equal(front.associationCount(), 1);

    // 客户端把封装好的数据报发到那个端口 → 经边车 → 原样回来（这里用不透明字节验证透传）。
    const payload = Buffer.concat([Buffer.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 53]), Buffer.from('dns-query-bytes')]);
    const reply = await udpEcho(client.bindHost, client.bindPort, payload);
    assert.deepEqual(reply, payload);

    // 控制连接断开 → 关联回收。
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(front.associationCount(), 0);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    front.stop();
    await new Promise((resolve) => sidecar.requestServer.close(resolve));
    sidecar.udp.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('a client that asks for no UDP front is told the command is unsupported', async () => {
  const sidecar = await startFakeUdpSidecar();
  const httpServer = await startHttpServer();
  const mux = createRelayPortMux({
    httpServer,
    resolveRelay: () => ({ enabled: true, password: PASSWORD, portForUser: () => sidecar.port })
  });
  const listener = mux.listener();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: listener.address().port });
      let stage = 'greeting';
      socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
      socket.on('data', (chunk) => {
        if (stage === 'greeting') {
          stage = 'auth';
          const user = Buffer.from('n_known');
          const pass = Buffer.from(PASSWORD);
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          return;
        }
        if (stage === 'auth') {
          stage = 'associate';
          socket.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        resolve(chunk[1]);
        socket.destroy();
      });
    });
    assert.equal(result, 0x07, '没有 UDP 前端时回「命令不支持」，而不是假装成功');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    await new Promise((resolve) => sidecar.requestServer.close(resolve));
    sidecar.udp.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
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

test('destroyConnections reaps handed-over sockets so shutdown does not wait for the client', async () => {
  const httpServer = await startHttpServer();
  const mux = createRelayPortMux({
    httpServer,
    resolveRelay: () => ({ enabled: true, password: PASSWORD, portForUser: () => 0 })
  });
  const listener = mux.listener();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const agent = new http.Agent({ keepAlive: true });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, agent }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
    });
    assert.equal(body, 'http:GET:/');
    // keep-alive socket 被交回 http server；而分流模式下 http server 从不 listen，
    // Node 的 closeIdleConnections/closeAllConnections 对它不生效——必须由分流器销毁，
    // 否则 listener.close() 要等客户端自己断开（实测 3s，停服被拖慢且连接泄漏）。
    assert.equal(mux.destroyConnections(), 1);
    assert.equal(mux.destroyConnections(), 0, '第二次调用不应重复计数');
    const closingStartedAt = Date.now();
    await new Promise((resolve) => listener.close(resolve));
    assert.ok(Date.now() - closingStartedAt < 1000, 'listener.close() 必须在销毁连接后立刻完成');
  } finally {
    agent.destroy();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
