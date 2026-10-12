'use strict';

// 节点 TCP 延迟：本机监听端口能连上并给出毫秒数，关闭的端口给出错误码，结果按 host:port 缓存。

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { NodeLatencyMeter } = require('../lib/cli/services/toolkit/subscription-aggregator/node-latency');

async function openPort(t) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('latency is measured per node and cached by address', async (t) => {
  const open = await openPort(t);
  const closed = await closedPort();
  let clock = 1000;
  let connects = 0;
  const meter = new NodeLatencyMeter({
    clock: () => clock,
    netConnect: (options) => {
      connects += 1;
      return net.connect(options);
    }
  });
  const first = await meter.measure([
    { key: 'a', server: '127.0.0.1', port: open },
    { key: 'b', server: '127.0.0.1', port: closed },
    { key: 'c', server: '127.0.0.1', port: open }
  ]);
  assert.equal(typeof first.a.ms, 'number');
  assert.deepEqual([first.b.ms, first.b.error, first.a.fakeIp], [null, 'ECONNREFUSED', false]);
  assert.equal(connects, 3);

  // 缓存期内不重测，fresh 或过期后重测。
  await meter.measure([{ key: 'a', server: '127.0.0.1', port: open }]);
  assert.equal(connects, 3);
  await meter.measure([{ key: 'a', server: '127.0.0.1', port: open }], { fresh: true });
  assert.equal(connects, 4);
  clock += 6 * 60 * 1000;
  await meter.measure([{ key: 'a', server: '127.0.0.1', port: open }]);
  assert.equal(connects, 5);
});

test('connections that never complete time out', async () => {
  const { EventEmitter } = require('node:events');
  const meter = new NodeLatencyMeter({
    timeoutMs: 50,
    netConnect: () => Object.assign(new EventEmitter(), { destroy() {} })
  });
  const result = await meter.measure([{ key: 'x', server: '203.0.113.1', port: 443 }]);
  assert.deepEqual([result.x.ms, result.x.error], [null, 'ETIMEDOUT']);
});
