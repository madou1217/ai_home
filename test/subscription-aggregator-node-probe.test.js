'use strict';

// 节点探针：用本机的假服务（SSH 横幅、SOCKS5、HTTP 代理、网站、不回应的端口、关闭的端口）和
// 注入的 TLS 连接（假证书）验证每种判断；DNS 由注入的 lookup 提供。

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { NodeProbe, certificateCovers, normalizeProbeInput } = require('../lib/cli/services/toolkit/subscription-aggregator/node-probe');

function listen(t, onConnection) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      onConnection(socket);
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 假 TLS：直接给出证书与 ALPN；收到 CONNECT 时按 proxyStatus 回应（0 = 不回应）。
function fakeTls({ names = [], alpn = 'h2', proxyStatus = 0, fail = false } = {}) {
  const calls = [];
  const connect = (options) => {
    calls.push(options);
    const socket = new EventEmitter();
    socket.alpnProtocol = alpn;
    socket.destroy = () => {};
    socket.getPeerCertificate = () => ({
      subject: { CN: names[0] || '' },
      subjectaltname: names.map((name) => `DNS:${name}`).join(', '),
      issuer: { O: 'Test CA' },
      valid_to: 'Dec 31 00:00:00 2030 GMT'
    });
    socket.write = () => {
      if (proxyStatus) setImmediate(() => socket.emit('data', Buffer.from(`HTTP/1.1 ${proxyStatus} X\r\n\r\n`)));
    };
    setImmediate(() => socket.emit(fail ? 'error' : 'secureConnect', fail ? new Error('wrong version') : undefined));
    return socket;
  };
  return { connect, calls };
}

function probeWith(options = {}) {
  return new NodeProbe({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    tlsConnect: fakeTls({ fail: true }).connect,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 300,
    bannerWaitMs: 150,
    ...options
  });
}

test('probe input accepts hosts and up to 32 ports', () => {
  assert.deepEqual(normalizeProbeInput({ host: ' [2001:DB8::1] ', port: '443' }), { host: '2001:db8::1', ports: [443] });
  assert.equal(normalizeProbeInput({ host: 'node.example.com' }).ports.length > 5, true, '不给端口时试常见端口');
  assert.throws(() => normalizeProbeInput({ host: 'bad host' }), { code: 'invalid_probe_host' });
  assert.throws(() => normalizeProbeInput({ host: 'a.com', ports: [0] }), { code: 'invalid_probe_port' });
  assert.throws(() => normalizeProbeInput({ host: 'a.com', ports: Array.from({ length: 33 }, (_v, i) => i + 1) }), { code: 'too_many_probe_ports' });
  assert.equal(certificateCovers(['*.example.com'], 'node.example.com'), true);
  assert.equal(certificateCovers(['*.example.com'], 'a.b.example.com'), false);
});

test('plain TCP services are told apart: SSH, SOCKS5, HTTP proxy, website, silent and closed ports', async (t) => {
  const ssh = await listen(t, (socket) => socket.write('SSH-2.0-OpenSSH_9.6\r\n'));
  const socks = await listen(t, (socket) => socket.on('data', (data) => (data[0] === 0x05 ? socket.write(Buffer.from([0x05, 0x02])) : socket.destroy())));
  const httpProxy = await listen(t, (socket) => socket.on('data', (data) => (String(data).startsWith('CONNECT') ? socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n') : socket.destroy())));
  const website = await listen(t, (socket) => socket.on('data', (data) => (String(data).startsWith('CONNECT') ? socket.write('HTTP/1.1 400 Bad Request\r\n\r\n') : socket.destroy())));
  const silent = await listen(t, () => {});
  const closed = await closedPort();

  const result = await probeWith().probe({ host: '127.0.0.1', ports: [ssh, socks, httpProxy, website, silent, closed] });
  const byPort = new Map(result.ports.map((item) => [item.port, item]));
  assert.deepEqual(byPort.get(ssh).candidates, ['ssh']);
  assert.match(byPort.get(ssh).note, /OpenSSH_9\.6/);
  assert.deepEqual([byPort.get(socks).socks5, byPort.get(socks).candidates], ['userpass', ['socks5']]);
  assert.deepEqual([byPort.get(httpProxy).httpStatus, byPort.get(httpProxy).candidates], [407, ['http']]);
  assert.deepEqual(byPort.get(website).candidates, ['vmess', 'vless']);
  assert.equal(byPort.get(silent).candidates[0], 'shadowsocks');
  assert.deepEqual([byPort.get(closed).open, byPort.get(closed).error], [false, 'ECONNREFUSED']);
  assert.ok(byPort.get(ssh).latencyMs >= 0);
  assert.equal(result.fakeIp, false);
});

test('TLS services report ALPN, certificate names and REALITY-like mismatches', async (t) => {
  const port = await listen(t, () => {});
  const host = 'node.example.com';

  const reality = fakeTls({ names: ['www.microsoft.com'] });
  const realityResult = (await probeWith({ tlsConnect: reality.connect }).probe({ host, ports: [port] })).ports[0];
  assert.equal(reality.calls[0].servername, host, 'SNI 用节点域名');
  assert.deepEqual([realityResult.tls.sniMatch, realityResult.candidates[0]], [false, 'vless']);
  assert.match(realityResult.note, /www\.microsoft\.com.*REALITY/);

  const matching = (await probeWith({ tlsConnect: fakeTls({ names: ['*.example.com'] }).connect }).probe({ host, ports: [port] })).ports[0];
  assert.deepEqual([matching.tls.sniMatch, matching.tls.alpn, matching.candidates[0]], [true, 'h2', 'trojan']);

  const httpsProxy = (await probeWith({ tlsConnect: fakeTls({ names: [host], proxyStatus: 407 }).connect }).probe({ host, ports: [port] })).ports[0];
  assert.deepEqual(httpsProxy.candidates, ['https']);
});

test('DNS failures, metadata addresses and fake-ip answers are reported', async () => {
  const notFound = await probeWith({ lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }).probe({ host: 'gone.example', ports: [443] });
  assert.deepEqual([notFound.dnsError, notFound.ports], ['ENOTFOUND', []]);
  await assert.rejects(
    probeWith({ lookup: async () => [{ address: '169.254.169.254', family: 4 }] }).probe({ host: 'metadata.example', ports: [80] }),
    { code: 'probe_address_blocked' }
  );
  const fake = await probeWith({
    lookup: async () => [{ address: '198.18.0.9', family: 4 }],
    netConnect: () => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      setImmediate(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
      return socket;
    }
  }).probe({ host: 'node.example.com', ports: [443] });
  assert.equal(fake.fakeIp, true);
});
