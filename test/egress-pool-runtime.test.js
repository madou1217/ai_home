'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const nodePath = require('node:path');
const { test } = require('node:test');

const { EgressPoolRuntime, pickPort } = require('../lib/runtime/egress-pool-runtime');

const NODES = [
  {
    protocol: 'vless', server: 'a.example.com', port: 443, uuid: 'u-1',
    network: 'tcp', tls: true, security: 'reality', sni: 'a.example.com',
    publicKey: 'pk-1', shortId: 'sid-1', fingerprint: 'ios'
  },
  {
    protocol: 'vless', server: 'b.example.com', port: 443, uuid: 'u-2',
    network: 'tcp', tls: true, security: 'reality', sni: 'b.example.com',
    publicKey: 'pk-2', shortId: 'sid-2', fingerprint: 'ios'
  }
];

// 内核就位：fs 报告托管内核存在，spawn 返回一个假子进程。
function coreAvailableDeps() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const writes = [];
  const chmods = [];
  const mkdirs = [];
  const state = { spawned: false };
  return {
    child,
    writes,
    chmods,
    mkdirs,
    state,
    fs: {
      statSync: (filePath) => {
        if (filePath === nodePath.join('/home/.ai_home', 'tools', 'mihomo')) {
          return { isFile: () => true, size: 4096 };
        }
        throw new Error('ENOENT');
      },
      mkdirSync: (dirPath, options) => { mkdirs.push({ dirPath, options }); },
      chmodSync: (filePath, mode) => { chmods.push({ filePath, mode }); },
      writeFileSync: (filePath, content, options) => { writes.push({ filePath, content, options }); }
    },
    spawn: () => { state.spawned = true; return child; }
  };
}

// 内核起来后控制端口应答 → 视为就绪；起来之前端口空闲（ECONNREFUSED）。
function alwaysReadyFetch(recorder, state) {
  return async (url, init) => {
    if (!state.spawned) throw new Error('ECONNREFUSED');
    const headers = (init && init.headers) || {};
    recorder.push({
      url,
      method: (init && init.method) || 'GET',
      body: (init && init.body) || '',
      authorization: headers.authorization || ''
    });
    return { ok: true, text: async () => '{"version":"fake"}' };
  };
}

function buildRuntime(overrides = {}) {
  const deps = coreAvailableDeps();
  const calls = [];
  const runtime = new EgressPoolRuntime({
    aiHomeDir: '/home/.ai_home',
    nodes: NODES,
    mixedPort: 17900,
    controllerPort: 19100,
    fs: deps.fs,
    spawn: deps.spawn,
    fetch: alwaysReadyFetch(calls, deps.state),
    networkInterfaces: () => ({ en1: [{ family: 'IPv4', address: '10.0.0.2', internal: false }] }),
    // 测试里把等待压到毫秒级：「内核不就绪」的用例不该空等 15s。
    startupTimeoutMs: 60,
    startupPollIntervalMs: 5,
    switchSettleMs: 0,
    ...overrides
  });
  return { runtime, deps, calls };
}

// ── 生命周期 ───────────────────────────────────────────────────────────────

test('proxyUrl is empty before start so callers fail closed', () => {
  const { runtime } = buildRuntime();
  assert.equal(runtime.proxyUrl, '');
  assert.equal(runtime.ready, false);
});

test('start() brings the pool up and exposes a loopback proxy url', async () => {
  const { runtime } = buildRuntime();
  const result = await runtime.start();
  assert.equal(result.ok, true);
  assert.equal(result.nodeCount, 2);
  // 只监听回环：绝不对局域网暴露出站端口。
  assert.equal(runtime.proxyUrl, 'http://127.0.0.1:17900');
  assert.equal(runtime.ready, true);
  runtime.stop();
});

test('start() is idempotent', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  const second = await runtime.start();
  assert.equal(second.ok, true);
  assert.equal(second.nodeCount, 2);
  runtime.stop();
});

test('a missing core fails closed instead of throwing', async () => {
  const deps = coreAvailableDeps();
  const { runtime } = buildRuntime({
    fs: {
      statSync: () => { throw new Error('ENOENT'); },
      mkdirSync: () => {},
      writeFileSync: () => {}
    },
    spawn: deps.spawn
  });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_core_not_found');
  assert.equal(runtime.proxyUrl, '');
});

test('an empty node pool fails closed', async () => {
  const { runtime } = buildRuntime({ nodes: [] });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_no_nodes');
});

test('a core that never answers the controller is treated as a failed start', async () => {
  const { runtime } = buildRuntime({
    fetch: async () => { throw new Error('ECONNREFUSED'); }
  });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(runtime.proxyUrl, '');
});

test('stop() is idempotent and kills the core once', async () => {
  const { runtime, deps } = buildRuntime();
  await runtime.start();
  runtime.stop();
  assert.equal(deps.child.killed, true);
  assert.equal(runtime.ready, false);
  runtime.stop(); // 第二次不应抛
  assert.equal(runtime.proxyUrl, '');
});

// ── 节点轮换（429 时的核心动作）────────────────────────────────────────────

test('rotateNode() advances to the next node and reports it', async () => {
  const { runtime, calls } = buildRuntime();
  await runtime.start();
  assert.equal(runtime.status.activeNode, 'node-0');
  const next = await runtime.rotateNode();
  assert.equal(next, 'node-1');
  assert.equal(runtime.status.activeNode, 'node-1');
  // 必须真的通过控制端口切了 GLOBAL 组。
  const switchCall = calls.find((call) => call.url.endsWith('/proxies/GLOBAL'));
  assert.equal(switchCall.method, 'PUT');
  assert.deepEqual(JSON.parse(switchCall.body), { name: 'node-1' });
  runtime.stop();
});

test('rotateNode() wraps around the pool', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  await runtime.rotateNode();
  const wrapped = await runtime.rotateNode();
  assert.equal(wrapped, 'node-0');
  runtime.stop();
});

test('rotateNode() on a stopped pool returns empty rather than throwing', async () => {
  const { runtime } = buildRuntime();
  assert.equal(await runtime.rotateNode(), '');
});

test('selectNode() targets a specific node by name', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  assert.equal(await runtime.selectNode('node-1'), 'node-1');
  assert.equal(runtime.status.activeNodeIndex, 1);
  assert.equal(await runtime.selectNode('nope'), '');
  runtime.stop();
});

test('a single-node pool still lets a retry happen on the same node', async () => {
  const { runtime } = buildRuntime({ nodes: [NODES[0]] });
  await runtime.start();
  assert.equal(await runtime.rotateNode(), 'node-0');
  runtime.stop();
});

// ── 落盘与状态 ─────────────────────────────────────────────────────────────

test('the compiled config is written where the core is pointed', async () => {
  const { runtime, deps } = buildRuntime();
  await runtime.start();
  const written = deps.writes.find((entry) => entry.filePath.endsWith('config.json'));
  assert.ok(written, 'config.json must be written');
  const config = JSON.parse(written.content);
  assert.equal(config['mixed-port'], 17900);
  assert.equal('tun' in config, false);
  runtime.stop();
});

test('status reports enough for the UI to explain the pool', async () => {
  const { runtime } = buildRuntime();
  await runtime.start();
  const status = runtime.status;
  assert.equal(status.ready, true);
  assert.equal(status.nodeCount, 2);
  assert.equal(status.activeNode, 'node-0');
  assert.match(status.proxyUrl, /^http:\/\/127\.0\.0\.1:/);
  runtime.stop();
});

test('pickPort stays inside the loopback-safe range', () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const port = pickPort(seed);
    assert.ok(port > 1024 && port < 65536, `port ${port} out of range`);
  }
});

// ── 加固：控制端口密钥、落盘权限、孤儿内核 ──────────────────────────────────

test('every controller call carries the per-start secret written into the config', async () => {
  const { runtime, deps, calls } = buildRuntime();
  await runtime.start();
  await runtime.rotateNode();
  const written = deps.writes.find((entry) => entry.filePath.endsWith('config.json'));
  const config = JSON.parse(written.content);
  assert.match(config.secret, /^[0-9a-f]{48}$/);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.equal(call.authorization, `Bearer ${config.secret}`);
  runtime.stop();
});

test('each start generates a fresh controller secret', async () => {
  const first = buildRuntime();
  const second = buildRuntime();
  await first.runtime.start();
  await second.runtime.start();
  const secretOf = (deps) => JSON.parse(
    deps.writes.find((entry) => entry.filePath.endsWith('config.json')).content
  ).secret;
  assert.notEqual(secretOf(first.deps), secretOf(second.deps));
  first.runtime.stop();
  second.runtime.stop();
});

test('the config with node credentials is written 0600 inside a 0700 directory', async () => {
  const { runtime, deps } = buildRuntime();
  await runtime.start();
  const written = deps.writes.find((entry) => entry.filePath.endsWith('config.json'));
  assert.equal(written.options.mode, 0o600);
  assert.equal(deps.mkdirs[0].options.mode, 0o700);
  // 已存在的文件/目录 mode 选项不生效，必须显式 chmod。
  assert.ok(deps.chmods.some((entry) => entry.filePath === written.filePath && entry.mode === 0o600));
  assert.ok(deps.chmods.some((entry) => entry.filePath === runtime.workDir && entry.mode === 0o700));
  runtime.stop();
});

test('an orphaned core already answering the controller port blocks the start', async () => {
  const deps = coreAvailableDeps();
  let spawned = false;
  const { runtime } = buildRuntime({
    spawn: () => { spawned = true; return deps.child; },
    // 孤儿内核：启动前就在应答。
    fetch: async () => ({ ok: true, text: async () => '{"version":"orphan"}' })
  });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_controller_port_in_use');
  assert.equal(spawned, false);
  assert.equal(runtime.proxyUrl, '');
});

test('a core that exits during startup is never reported ready even if the port answers', async () => {
  const deps = coreAvailableDeps();
  // 控制端口「应答」只在子进程退出之后才返回：确定性地复现「别的进程仍在应答、自己的内核已退出」，
  // 不依赖 setImmediate 与定时器的先后（旧写法 2ms 定时器在高负载下偶发先于退出事件）。
  const exited = new Promise((resolve) => deps.child.once('exit', resolve));
  const { runtime } = buildRuntime({
    spawn: () => {
      deps.state.spawned = true;
      // 端口冲突：新进程立刻退出，而别的进程仍在应答控制端口。
      setImmediate(() => deps.child.emit('exit', 1));
      return deps.child;
    },
    fetch: async () => {
      if (!deps.state.spawned) throw new Error('ECONNREFUSED');
      await exited;
      return { ok: true, text: async () => '{}' };
    }
  });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_core_exited');
  assert.equal(runtime.ready, false);
});

test('a core that dies after startup drops the pool out of ready', async () => {
  const { runtime, deps } = buildRuntime();
  await runtime.start();
  assert.equal(runtime.ready, true);
  deps.child.emit('exit', 1);
  assert.equal(runtime.ready, false);
  assert.equal(runtime.proxyUrl, '');
});

// ── v3：运行文件、孤儿回收、stop 抢在启动途中 ───────────────────────────────

const STATE_PATH = nodePath.join('/home/.ai_home', 'run', 'egress-pool', 'state.json');

function withStateFile(deps, state) {
  const removed = [];
  deps.fs.readFileSync = (filePath) => {
    if (filePath === STATE_PATH && state.current) return JSON.stringify(state.current);
    throw new Error('ENOENT');
  };
  deps.fs.rmSync = (filePath) => { removed.push(filePath); if (filePath === STATE_PATH) state.current = null; };
  return removed;
}

test('a ready pool writes a 0600 run file for CLI processes and removes it on stop', async () => {
  const { runtime, deps } = buildRuntime({ processObj: { pid: 4242, kill: () => {} } });
  deps.child.pid = 5151;
  const removed = withStateFile(deps, {});
  await runtime.start();
  const written = deps.writes.find((entry) => entry.filePath === STATE_PATH);
  assert.ok(written, 'state.json must be written once the pool is ready');
  assert.equal(written.options.mode, 0o600);
  const state = JSON.parse(written.content);
  assert.equal(state.ownerPid, 4242);
  assert.equal(state.corePid, 5151);
  assert.equal(state.proxyUrl, 'http://127.0.0.1:17900');
  runtime.stop();
  assert.ok(removed.includes(STATE_PATH));
});

test('our own crash-orphaned core is reaped (verified by its secret) and the pool starts', async () => {
  const deps = coreAvailableDeps();
  const state = {
    current: {
      version: 1, ownerPid: 111, corePid: 222, proxyUrl: 'http://127.0.0.1:17900',
      controllerPort: 19100, secret: 'old-secret', startedAt: 1
    }
  };
  const alive = new Set([222]);
  const killed = [];
  const orphanCalls = [];
  const { runtime } = buildRuntime({
    fs: deps.fs,
    spawn: () => { deps.state.spawned = true; return deps.child; },
    processObj: { pid: 999, kill: (pid, signal) => { killed.push({ pid, signal }); alive.delete(pid); } },
    isPidAlive: (pid) => alive.has(pid),
    fetch: async (url, init) => {
      const auth = (init && init.headers && init.headers.authorization) || '';
      if (alive.has(222)) {
        orphanCalls.push(auth);
        return { ok: auth === 'Bearer old-secret', text: async () => '{}' };
      }
      if (!deps.state.spawned) throw new Error('ECONNREFUSED');
      return { ok: true, text: async () => '{}' };
    }
  });
  withStateFile(deps, state);
  const result = await runtime.start();
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [{ pid: 222, signal: 'SIGTERM' }]);
  assert.ok(orphanCalls.includes('Bearer old-secret'));
  runtime.stop();
});

test('a core that does not answer with our recorded secret is never killed', async () => {
  const deps = coreAvailableDeps();
  const state = {
    current: {
      version: 1, ownerPid: 111, corePid: 222, proxyUrl: 'http://127.0.0.1:17900',
      controllerPort: 19100, secret: 'old-secret', startedAt: 1
    }
  };
  const killed = [];
  const { runtime } = buildRuntime({
    fs: deps.fs,
    spawn: deps.spawn,
    processObj: { pid: 999, kill: (pid) => { killed.push(pid); } },
    isPidAlive: (pid) => pid === 222,
    // 端口上是别人的进程：对我们的密钥一律 401。
    fetch: async () => ({ ok: false, status: 401, text: async () => '' })
  });
  withStateFile(deps, state);
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_controller_port_in_use');
  assert.deepEqual(killed, []);
});

test('a live server owning the run file is never reaped', async () => {
  const deps = coreAvailableDeps();
  const state = {
    current: {
      version: 1, ownerPid: 111, corePid: 222, proxyUrl: 'http://127.0.0.1:17900',
      controllerPort: 19100, secret: 'old-secret', startedAt: 1
    }
  };
  const killed = [];
  const { runtime } = buildRuntime({
    fs: deps.fs,
    spawn: deps.spawn,
    processObj: { pid: 999, kill: (pid) => { killed.push(pid); } },
    isPidAlive: () => true,
    fetch: async () => ({ ok: true, text: async () => '{}' })
  });
  withStateFile(deps, state);
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_controller_port_in_use');
  assert.deepEqual(killed, []);
});

test('stop() racing the pre-spawn port probe never spawns an untracked core', async () => {
  const deps = coreAvailableDeps();
  let spawned = 0;
  let runtimeRef = null;
  const { runtime } = buildRuntime({
    spawn: () => { spawned += 1; return deps.child; },
    fetch: async () => {
      // stop() 恰好落在端口探测的 await 里（shutdown 与惰性启动相撞）。
      runtimeRef.stop();
      throw new Error('ECONNREFUSED');
    }
  });
  runtimeRef = runtime;
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_stopped_during_start');
  assert.equal(spawned, 0);
  assert.equal(runtime.ready, false);
});

test('stop() racing readiness kills the spawned core', async () => {
  const deps = coreAvailableDeps();
  let runtimeRef = null;
  let kills = 0;
  deps.child.kill = () => { kills += 1; };
  const { runtime } = buildRuntime({
    spawn: () => { deps.state.spawned = true; return deps.child; },
    fetch: async () => {
      if (!deps.state.spawned) throw new Error('ECONNREFUSED');
      runtimeRef.stop();
      return { ok: true, text: async () => '{}' };
    }
  });
  runtimeRef = runtime;
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'egress_pool_stopped_during_start');
  assert.ok(kills >= 1);
  assert.equal(runtime.ready, false);
});
