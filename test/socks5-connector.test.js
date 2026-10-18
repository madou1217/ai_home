'use strict';

// SOCKS5 出口连接器（lib/server/socks5-connector.js）与 dispatcher 接线。
//
// 这里刻意**不 mock 协议**：起一个真的 SOCKS5 服务端（最小实现），验证握手字节、
// socks5 与 socks5h 的解析位置差异、认证分支、失败路径。理由是这个模块存在的意义
// 就是「让 socks 出口真的能用」——只用假 socket 测握手顺序，无法证明它没把域名
// 泄漏给本地 DNS，也无法证明失败时不会静默直连。

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  createSocks5Connector,
  isSocksProxyUrl
} = require('../lib/server/socks5-connector');

const SOCKS_VERSION = 0x05;

/**
 * 最小 SOCKS5 服务端：只做 CONNECT，记录收到的目标，随后回一个固定的 CONNECT 应答。
 * 返回 { port, requests, close, sockets }。
 */
function createSocksServer(options = {}) {
  const requests = [];
  const sockets = new Set();
  const requireAuth = options.requireAuth === true;
  const replyCode = Number.isInteger(options.replyCode) ? options.replyCode : 0x00;
  const replyBound = Buffer.isBuffer(options.replyBound)
    ? options.replyBound
    : Buffer.from([0x01, 0, 0, 0, 0, 0, 0]);
  const replySplits = Array.isArray(options.replySplits) ? options.replySplits : [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* 测试里的对端可能被主动销毁 */ });
    let stage = 'greeting';
    let pending = Buffer.alloc(0);

    const readExact = (count, onReady) => {
      if (pending.length < count) return;
      const frame = pending.subarray(0, count);
      pending = pending.subarray(count);
      onReady(frame);
    };

    const handleRequest = () => {
      readExact(4, (head) => {
        const atyp = head[3];
        const finish = (host) => {
          readExact(2, (portBytes) => {
            requests.push({ atyp, host, port: portBytes.readUInt16BE(0) });
            // 应答：VER REP RSV ATYP BND.ADDR BND.PORT（默认 IPv4；replyBound 可换成域名类型）
            const reply = Buffer.concat([Buffer.from([SOCKS_VERSION, replyCode, 0x00]), replyBound]);
            if (replySplits.length === 0) {
              socket.write(reply);
            } else {
              // 按给定切点把应答拆成多个 TCP 段，段间留出时间，确保客户端分多次 data 收到。
              const cuts = [0, ...replySplits, reply.length];
              cuts.slice(1).forEach((end, index) => {
                setTimeout(() => {
                  if (!socket.destroyed) socket.write(reply.subarray(cuts[index], end));
                }, index * 30);
              });
            }
            // 一条连接只服务一个 CONNECT：应答之后客户端可能开始说 TLS，
            // 再按 SOCKS 解析那些字节会记出假请求（测试桩自身的坑）。
            stage = 'done';
          });
        };
        if (atyp === 0x01) return readExact(4, (addr) => finish(addr.join('.')));
        if (atyp === 0x04) return readExact(16, (addr) => finish(addr.toString('hex')));
        if (atyp === 0x03) return readExact(1, (len) => readExact(len[0], (addr) => finish(addr.toString('utf8'))));
        finish('');
      });
    };

    const dispatch = () => {
      if (stage === 'done') return;
      if (stage === 'greeting') {
        readExact(2, (frame) => {
          if (frame[0] !== SOCKS_VERSION) return socket.destroy();
          const methods = [];
          readExact(frame[1], (list) => {
            for (const method of list) methods.push(method);
            if (requireAuth) {
              if (!methods.includes(0x02)) return socket.destroy();
              socket.write(Buffer.from([SOCKS_VERSION, 0x02]));
              stage = 'auth';
              dispatch();
              return;
            }
            socket.write(Buffer.from([SOCKS_VERSION, 0x00]));
            stage = 'request';
            dispatch();
          });
        });
        return;
      }
      if (stage === 'auth') {
        readExact(2, (frame) => {
          readExact(frame[1], (user) => {
            readExact(1, (passLen) => {
              readExact(passLen[0], () => {
                socket.write(Buffer.from([0x01, 0x00]));
                requests.push({ auth: user.toString('utf8') });
                stage = 'request';
                dispatch();
              });
            });
          });
        });
        return;
      }
      handleRequest();
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      dispatch();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        // 刻意不 await server.close()：还有连接挂着时它的回调不会触发，而测试的
        // t.after 里等一个不 settle 的 Promise 会让整个用例被判定为挂起。
        // 先销毁所有连接再 close，且不等结果。
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        }
      });
    });
  });
}

/** 用连接器建隧道；成功返回 socket，失败返回错误。 */
function connectThrough(proxyUrl, target, options = {}) {
  const connect = createSocks5Connector(proxyUrl, options);
  return new Promise((resolve) => {
    connect({ hostname: target.host, port: target.port, protocol: target.protocol || 'http:' }, (error, socket) => {
      if (error) return resolve({ error });
      resolve({ socket });
    });
  });
}

test('isSocksProxyUrl 只认 socks5 与 socks5h', () => {
  assert.equal(isSocksProxyUrl('socks5://127.0.0.1:1080'), true);
  assert.equal(isSocksProxyUrl('socks5h://127.0.0.1:1080'), true);
  assert.equal(isSocksProxyUrl('SOCKS5://127.0.0.1:1080'), true);
  assert.equal(isSocksProxyUrl('http://127.0.0.1:8080'), false);
  assert.equal(isSocksProxyUrl('socks4://127.0.0.1:1080'), false);
  assert.equal(isSocksProxyUrl('socks://127.0.0.1:1080'), false);
  assert.equal(isSocksProxyUrl(''), false);
  assert.equal(isSocksProxyUrl('not a url'), false);
});

test('createSocks5Connector 拒绝非 socks 地址（构造期就失败，不留到请求时）', () => {
  assert.throws(() => createSocks5Connector('http://127.0.0.1:8080'), /socks5_proxy_url_invalid/);
  assert.throws(() => createSocks5Connector(''), /socks5_proxy_url_invalid/);
  assert.equal(typeof createSocks5Connector('socks5://127.0.0.1:1080'), 'function');
});

// socks5h 必须把**域名**交给代理（ATYP=3）：这是它与 socks5 的关键区别，
// 也是「本地 DNS 被污染/不可达时仍可用」的唯一保证。
test('socks5h 把域名交给代理解析（ATYP=domain），不在本地解析', async (t) => {
  const server = await createSocksServer();
  t.after(() => server.close());

  const result = await connectThrough(`socks5h://127.0.0.1:${server.port}`, {
    host: 'example.invalid', port: 8443
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  result.socket.destroy();

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].atyp, 0x03, 'socks5h 必须是域名类��');
  assert.equal(server.requests[0].host, 'example.invalid');
  assert.equal(server.requests[0].port, 8443);
});

// socks5（本地解析）必须发 IP 字面量而不是域名：与 curl/Go 的同名 scheme 语义一致。
// 刻意不断言具体是 v4 还是 v6 —— localhost 在双栈机器上解析成 ::1 是正常的，
// 关键判据是「类型是 IP 而不是 domain」。
test('socks5 在本地解析后发 IP 字面量（ATYP 为 IPv4/IPv6，而非 domain）', async (t) => {
  const server = await createSocksServer();
  t.after(() => server.close());

  const result = await connectThrough(`socks5://127.0.0.1:${server.port}`, {
    host: 'localhost', port: 80
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  result.socket.destroy();

  assert.equal(server.requests.length, 1);
  assert.notEqual(server.requests[0].atyp, 0x03, 'socks5 不得把域名交给代理');
  assert.ok([0x01, 0x04].includes(server.requests[0].atyp), `IP 类型，实际 ${server.requests[0].atyp}`);
});

// 远端代理可能把 CONNECT 应答拆成多个 TCP 段：头部先到、地址后到时不能把地址字节当成新头部。
test('CONNECT 应答被拆成多个 TCP 段时仍能完成握手（IPv4 与域名类型）', async (t) => {
  const domain = Buffer.from('proxy.example', 'utf8');
  const cases = [
    { label: 'ipv4 4|6', replyBound: Buffer.from([0x01, 10, 0, 0, 1, 0x1f, 0x90]), replySplits: [4] },
    { label: 'ipv4 1|3|6', replyBound: Buffer.from([0x01, 10, 0, 0, 1, 0x1f, 0x90]), replySplits: [1, 4] },
    {
      label: 'domain 4|1|rest',
      replyBound: Buffer.concat([Buffer.from([0x03, domain.length]), domain, Buffer.from([0x1f, 0x90])]),
      replySplits: [4, 5, 9]
    }
  ];
  for (const item of cases) {
    const server = await createSocksServer({ replyBound: item.replyBound, replySplits: item.replySplits });
    t.after(() => server.close());
    const result = await connectThrough(`socks5h://127.0.0.1:${server.port}`, { host: 'example.invalid', port: 80 });
    assert.equal(result.error, undefined, `${item.label}: ${result.error && result.error.message}`);
    result.socket.destroy();
  }
});

test('缺省端口按目标协议补全（https 443 / http 80）', async (t) => {
  const server = await createSocksServer();
  t.after(() => server.close());

  // https 目标：握手完成后连接器会包 TLS，而桩服务端不会说 TLS —— 因此连接最终失败，
  // 但 CONNECT 请求已经发出，端口补全这件事可以直接断言。
  const https = await connectThrough(`socks5h://127.0.0.1:${server.port}`, {
    host: 'example.invalid', port: '', protocol: 'https:'
  });
  if (https.socket) https.socket.destroy();
  assert.equal(server.requests[0].port, 443, 'https 缺省端口必须是 443');

  const http = await connectThrough(`socks5h://127.0.0.1:${server.port}`, {
    host: 'example.invalid', port: '', protocol: 'http:'
  });
  assert.equal(http.error, undefined, http.error && http.error.message);
  http.socket.destroy();
  assert.equal(server.requests[1].port, 80, 'http 缺省端口必须是 80');
});

test('代理要求认证时发送用户名/密码并继续握手', async (t) => {
  const server = await createSocksServer({ requireAuth: true });
  t.after(() => server.close());

  const result = await connectThrough(`socks5h://alice:secret@127.0.0.1:${server.port}`, {
    host: 'example.invalid', port: 443
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  result.socket.destroy();

  assert.equal(server.requests[0].auth, 'alice');
  assert.equal(server.requests[1].host, 'example.invalid');
});

test('代理返回非 0 应答码时给出可读错误（不静默直连）', async (t) => {
  const server = await createSocksServer({ replyCode: 0x05 }); // connection_refused
  t.after(() => server.close());

  const result = await connectThrough(`socks5h://127.0.0.1:${server.port}`, {
    host: 'example.invalid', port: 443
  });
  assert.ok(result.error, '必须失败');
  assert.match(result.error.message, /connection_refused/);
});

test('代理不可达时报错而不是直连', async () => {
  // 127.0.0.1:1 上没有监听者。
  const result = await connectThrough('socks5h://127.0.0.1:1', { host: 'example.invalid', port: 443 });
  assert.ok(result.error, '必须失败而不是静默直连');
  assert.match(String(result.error.code || result.error.message), /ECONNREFUSED|socks5_/);
});

test('握手超时受 options.timeout 控制（代理接受连接但不回应）', async (t) => {
  // 一个只接受连接、永不回应的服务端。
  const silent = net.createServer(() => { /* 什么都不做 */ });
  const port = await new Promise((resolve) => {
    silent.listen(0, '127.0.0.1', () => resolve(silent.address().port));
  });
  t.after(() => silent.close());

  const started = Date.now();
  const result = await connectThrough(`socks5h://127.0.0.1:${port}`, { host: 'example.invalid', port: 443 }, {
    timeout: 200
  });
  assert.ok(result.error);
  assert.match(result.error.message, /socks5_handshake_timeout/);
  assert.ok(Date.now() - started < 5000, '超时必须及时生效');
  assert.ok(DEFAULT_HANDSHAKE_TIMEOUT_MS >= 1000);
});

// 网关热路径的接线：resolveProxyConfig 不能把 socks 丢掉（丢了就是直连），
// getProxyDispatcher 必须给出真的能建隧道的 agent。
test('resolveProxyConfig 保留 socks5，dispatcher 给出可建隧道的 agent', async (t) => {
  const utils = require('../lib/server/http-utils-utils');
  const server = await createSocksServer();
  t.after(() => server.close());
  t.after(() => utils.setUndiciHooksForTest({}));

  const proxyUrl = `socks5h://127.0.0.1:${server.port}`;
  const config = utils.resolveProxyConfig('https://api.example.com/v1/messages', { proxyUrl });
  assert.equal(config.url, proxyUrl, 'socks5 必须原样保留');
  assert.equal(config.source, 'explicit');

  const dispatcher = utils.getProxyDispatcher(proxyUrl);
  assert.ok(dispatcher, 'dispatcher 不得为 null（null 会让调用方直连）');

  // 用这个 dispatcher 真打一次：请求应当经由我们的 SOCKS 服务端。
  const { fetch } = require('undici');
  await assert.rejects(
    () => fetch('https://api.example.com/v1/messages', { dispatcher, signal: AbortSignal.timeout(3000) }),
    () => true,
    '上游不存在，必须失败'
  );
  assert.equal(server.requests.length, 1, '请求必须真的走了 SOCKS 隧道');
  assert.equal(server.requests[0].atyp, 0x03);
  assert.equal(server.requests[0].host, 'api.example.com');
});

test('resolveProxyConfig 对 socks4 等不支持的 scheme 返回空（调用方按无代理处理）', () => {
  const utils = require('../lib/server/http-utils-utils');
  for (const scheme of ['socks4', 'ftp', 'ss']) {
    const config = utils.resolveProxyConfig('https://api.example.com/v1/messages', {
      proxyUrl: `${scheme}://127.0.0.1:1080`
    });
    assert.equal(config.url, '', scheme);
    assert.equal(utils.getProxyDispatcher(`${scheme}://127.0.0.1:1080`), null, scheme);
  }
});

// SOCKS 与 HTTP 出口必须共用长流超时：否则同一条长生成请求经 HTTP 出口成功、
// 经 SOCKS 出口在 undici 默认 300s 被掐断。
test('SOCKS 与 HTTP dispatcher 使用同一组 30 分钟长流超时', (t) => {
  const utils = require('../lib/server/http-utils-utils');
  const captured = {};
  class FakeAgent { constructor(options) { captured.socks = options; } }
  class FakeProxyAgent { constructor(options) { captured.http = options; } }
  utils.setUndiciHooksForTest({
    requireFn: () => ({ Agent: FakeAgent, ProxyAgent: FakeProxyAgent })
  });
  t.after(() => utils.setUndiciHooksForTest({}));

  assert.ok(utils.getProxyDispatcher('socks5://127.0.0.1:1080'));
  assert.ok(utils.getProxyDispatcher('http://127.0.0.1:7890'));
  assert.equal(utils.PROXY_STREAM_IDLE_TIMEOUT_MS, 1_800_000);
  for (const kind of ['socks', 'http']) {
    assert.equal(captured[kind].bodyTimeout, utils.PROXY_STREAM_IDLE_TIMEOUT_MS, kind);
    assert.equal(captured[kind].headersTimeout, utils.PROXY_STREAM_IDLE_TIMEOUT_MS, kind);
  }
  assert.equal(typeof captured.socks.connect, 'function');
});
