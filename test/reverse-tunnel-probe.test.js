'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  ReverseTunnel,
  ReverseTunnelSupervisor
} = require('../lib/remote-workspace/transport/reverse-tunnel');

function fakeRemote(forwardIn) {
  const remote = new EventEmitter();
  remote.forwardIn = forwardIn || ((host, port, cb) => cb(null, port));
  remote.unforwardIn = (host, port, cb) => { if (cb) cb(); };
  return remote;
}

function bindTakenError() {
  return new Error('Unable to bind to 127.0.0.1:22022');
}

/** 建一条已经 open 的隧道；open 用默认成功的 forwardIn，之后再把探活行为换掉。 */
async function openedTunnel() {
  const tunnel = new ReverseTunnel({ remote: fakeRemote(), remotePort: 22022, localPort: 22 });
  await tunnel.open();
  return tunnel;
}

// 假时钟：超时与间隔分开记，测试里手动触发。
function createClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimer(id) { timers.delete(id); },
    setIntervalTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearIntervalTimer(id) { timers.delete(id); },
    fireKind(kind) {
      const ids = [...timers].filter(([, timer]) => timer.kind === kind).map(([id]) => id);
      for (const id of ids) {
        const timer = timers.get(id);
        if (!timer) continue;
        if (kind === 'timeout') timers.delete(id);
        timer.fn();
      }
      return ids.length;
    },
    pending(kind) { return [...timers.values()].filter((timer) => timer.kind === kind).length; }
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeTunnel({ probe } = {}) {
  return {
    closed: false,
    stats: { connections: 0, failed: 0, rebounds: 0 },
    async probe() { if (probe) return probe(); },
    close() { this.closed = true; }
  };
}

test('probe：sshd 回「Unable to bind」说明转发还在我们自己手上，算健康', async () => {
  const tunnel = await openedTunnel();
  tunnel.remote.forwardIn = (host, port, cb) => cb(bindTakenError());
  await tunnel.probe(500);
  assert.equal(tunnel.stats.rebounds, 0);
});

test('probe：重新绑上说明转发此前已丢，自愈并计入 rebounds', async () => {
  const tunnel = await openedTunnel();
  tunnel.remote.forwardIn = (host, port, cb) => cb(null, port);
  await tunnel.probe(500);
  assert.equal(tunnel.stats.rebounds, 1);
});

test('probe：连接已断（ssh2 同步抛 Not connected）判为不可用', async () => {
  const tunnel = await openedTunnel();
  tunnel.remote.forwardIn = () => { throw new Error('Not connected'); };
  await assert.rejects(() => tunnel.probe(500), (error) => error.code === 'probe_failed');
});

test('probe：回调一直不来（半开连接）按超时判死', async () => {
  const tunnel = await openedTunnel();
  tunnel.remote.forwardIn = () => { /* 永不回调 */ };
  // 探活超时定时器是 unref 的（生产上不能拖住进程），测试里自己撑住事件循环。
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(() => tunnel.probe(30), (error) => error.code === 'probe_timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('close 幂等：重复关闭不会再次 unforwardIn', async () => {
  const tunnel = await openedTunnel();
  let unforwardCalls = 0;
  tunnel.remote.unforwardIn = (host, port, cb) => { unforwardCalls += 1; if (cb) cb(); };
  tunnel.close();
  tunnel.close();
  assert.equal(unforwardCalls, 1);
  assert.equal(tunnel.port, 0);
});

test('监督者：探活失败会关掉隧道并按退避重建', async () => {
  const clock = createClock();
  const opened = [];
  const supervisor = new ReverseTunnelSupervisor({
    openTunnel: async () => {
      const tunnel = fakeTunnel({ probe: async () => { throw Object.assign(new Error('隧道连接无响应'), { code: 'probe_timeout' }); } });
      opened.push(tunnel);
      return { tunnel, raw: new EventEmitter() };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
    probeIntervalMs: 1000,
    probeTimeoutMs: 100,
    log: () => {}
  });
  supervisor.start('conn_1', { remotePort: 22022, localPort: 22 });
  await flush();
  assert.equal(supervisor.status()[0].status, 'open');

  clock.fireKind('interval');
  await flush();
  const afterProbe = supervisor.status()[0];
  assert.equal(afterProbe.status, 'retrying');
  assert.equal(afterProbe.error, 'probe_timeout');
  assert.equal(opened[0].closed, true, '死掉的隧道要被关掉');
  assert.equal(clock.pending('interval'), 0, '探活定时器要停');
  assert.equal(clock.pending('timeout'), 1, '要排一次退避重连');

  clock.fireKind('timeout');
  await flush();
  assert.equal(supervisor.status()[0].status, 'open');
  assert.equal(opened.length, 2);
  supervisor.close();
});

test('监督者：探活成功只更新 lastProbeAt，不重建', async () => {
  const clock = createClock();
  let opens = 0;
  const supervisor = new ReverseTunnelSupervisor({
    openTunnel: async () => { opens += 1; return { tunnel: fakeTunnel(), raw: new EventEmitter() }; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
    probeIntervalMs: 1000,
    probeTimeoutMs: 100,
    now: () => 1234,
    log: () => {}
  });
  supervisor.start('conn_1', { remotePort: 22022, localPort: 22 });
  await flush();
  clock.fireKind('interval');
  await flush();
  assert.equal(supervisor.status()[0].status, 'open');
  assert.equal(supervisor.status()[0].lastProbeAt, 1234);
  assert.equal(opens, 1);
  supervisor.close();
});

test('监督者：旧连接迟到的 close 不会把新一代隧道重连掉', async () => {
  const clock = createClock();
  const raws = [];
  const supervisor = new ReverseTunnelSupervisor({
    openTunnel: async () => {
      const raw = new EventEmitter();
      raws.push(raw);
      return { tunnel: fakeTunnel(), raw };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
    probeIntervalMs: 0,
    probeTimeoutMs: 100,
    log: () => {}
  });
  supervisor.start('conn_1', { remotePort: 22022, localPort: 22 });
  await flush();
  raws[0].emit('close');
  clock.fireKind('timeout');
  await flush();
  assert.equal(raws.length, 2);
  // 第一代连接的 close 迟到：不应再排新的重连
  raws[0].emit('close');
  assert.equal(clock.pending('timeout'), 0);
  assert.equal(supervisor.status()[0].status, 'open');
  supervisor.close();
});

test('监督者：连接还没建好就被停掉时，建好后立刻关掉，不碰别的隧道', async () => {
  const clock = createClock();
  const opened = [];
  let releaseOpen = null;
  const supervisor = new ReverseTunnelSupervisor({
    openTunnel: () => new Promise((resolve) => {
      releaseOpen = () => {
        const tunnel = fakeTunnel();
        opened.push(tunnel);
        resolve({ tunnel, raw: new EventEmitter() });
      };
    }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
    probeIntervalMs: 1000,
    probeTimeoutMs: 100,
    log: () => {}
  });
  supervisor.start('conn_1', { remotePort: 22022, localPort: 22 });
  supervisor.stop('conn_1');
  releaseOpen();
  await flush();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, true, '迟到的隧道要被关掉');
  assert.equal(supervisor.status().length, 0);
});

test('监督者：open / 探活 / 判死都写日志', async () => {
  const clock = createClock();
  const events = [];
  let fail = false;
  const supervisor = new ReverseTunnelSupervisor({
    openTunnel: async () => ({
      tunnel: fakeTunnel({ probe: async () => { if (fail) throw Object.assign(new Error('隧道连接无响应'), { code: 'probe_timeout' }); } }),
      raw: new EventEmitter()
    }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
    probeIntervalMs: 1000,
    probeTimeoutMs: 100,
    log: (event) => events.push(event)
  });
  supervisor.start('conn_1', { remotePort: 22022, localPort: 22 });
  await flush();
  assert.equal(events[0].kind, 'reverse_tunnel_open');

  clock.fireKind('interval');
  await flush();
  const probe = events.find((event) => event.kind === 'reverse_tunnel_probe');
  assert.ok(probe, '探活成功要有心跳日志');
  assert.equal(probe.ok, true);
  assert.equal(probe.remotePort, 22022);

  fail = true;
  clock.fireKind('interval');
  await flush();
  const dead = events.find((event) => event.kind === 'reverse_tunnel_dead');
  assert.ok(dead, '判死要有日志');
  assert.equal(dead.connectionId, 'conn_1');
  assert.ok(events.some((event) => event.kind === 'reverse_tunnel_retry'));
  supervisor.close();
});
