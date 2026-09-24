'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildGoCoreInvocation,
  createGoCoreSupervisor,
  resolveGoServerBinary,
  validatePrivateEndpoint
} = require('../lib/cli/services/server/go-core-supervisor');

test('Go Core endpoint rejects public 9527 and non-loopback binding', () => {
  assert.throws(
    () => validatePrivateEndpoint({ host: '127.0.0.1', port: 9527 }),
    (error) => error.code === 'go_core_endpoint_conflicts_public'
  );
  assert.throws(
    () => validatePrivateEndpoint({ host: '0.0.0.0', port: 19550 }),
    (error) => error.code === 'go_core_endpoint_not_private'
  );
  assert.throws(
    () => validatePrivateEndpoint({ host: '127.0.0.1', port: 0 }),
    (error) => error.code === 'go_core_endpoint_invalid'
  );
});

test('Go Core invocation keeps credentials out of argv and binds a private endpoint', () => {
  const invocation = buildGoCoreInvocation({
    binaryPath: '/tmp/aih-server',
    aiHomeDir: '/tmp/aih-home',
    managementKey: 'management-secret',
    clientKey: 'client-secret',
    host: '127.0.0.1',
    port: 19551,
    baseEnv: { PATH: '/usr/bin' }
  });

  assert.deepEqual(invocation.args, ['--host', '127.0.0.1', '--port', '19551']);
  assert.equal(invocation.env.AIH_HOME, '/tmp/aih-home');
  assert.equal(invocation.env.AIH_SERVER_MANAGEMENT_KEY, 'management-secret');
  assert.equal(invocation.env.AIH_SERVER_CLIENT_KEY, 'client-secret');
  assert.equal(invocation.args.includes('management-secret'), false);
  assert.equal(invocation.args.includes('client-secret'), false);
});

test('enabled supervisor starts once the private endpoint serves (not only once accounts exist) and stops its child', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-core-supervisor-'));
  const binaryPath = path.join(tempDir, 'aih-server');
  fs.writeFileSync(binaryPath, 'placeholder');
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = (signal) => killed.push({ pid: child.pid, signal });
  const spawned = [];
  const killed = [];

  try {
    const supervisor = createGoCoreSupervisor({
      enabled: true,
      fs,
      path,
      // 占位二进制没有 build stamp；构件校验由专门的用例覆盖。
      verifyBuild: false,
      processObj: {
        env: { PATH: '/usr/bin' },
        kill: (pid, signal) => killed.push({ pid, signal })
      },
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        return child;
      },
      fetchImpl: async (url) => {
        // 门限是进程在服务（/healthz），不要求 aih.db 已有账号：账号由 Node 在 Go 起来后同步。
        assert.equal(url, 'http://127.0.0.1:19550/healthz');
        return {
          ok: true,
          json: async () => ({ ok: true, service: 'aih-server' })
        };
      },
      sleep: async () => {}
    });

    const started = await supervisor.start({
      binaryPath,
      aiHomeDir: tempDir,
      managementKey: 'management-secret',
      clientKey: 'client-secret'
    });

    assert.equal(started.state, 'ready');
    assert.equal(started.pid, 4242);
    assert.equal(started.endpoint, 'http://127.0.0.1:19550');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['--host', '127.0.0.1', '--port', '19550']);
    // stdout/stderr 接到 go-core.log，Go 启动失败不再无声无息。
    assert.deepEqual(spawned[0].options.stdio, ['ignore', 'pipe', 'pipe']);

    const stopped = await supervisor.stop({ timeoutMs: 1 });
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(killed, [
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' }
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('enabled supervisor fails closed when the Go server binary is absent', async () => {
  const supervisor = createGoCoreSupervisor({
    enabled: true,
    fs: { existsSync: () => false },
    processObj: { env: {} }
  });

  await assert.rejects(
    () => supervisor.start({
      binaryPath: '/tmp/missing-aih-server',
      aiHomeDir: '/tmp/aih-home',
      managementKey: 'management-secret',
      clientKey: 'client-secret'
    }),
    (error) => error.code === 'go_core_binary_missing'
  );
});

test('Go Core binary path follows the npm build layout and adds .exe on Windows', () => {
  assert.equal(
    resolveGoServerBinary({ repositoryRoot: '/repo', platform: 'linux', arch: 'x64', path: path.posix }),
    '/repo/bin/native/linux-x64/aih-server'
  );
  assert.equal(
    resolveGoServerBinary({ repositoryRoot: 'C:\\repo', platform: 'win32', arch: 'x64', path: path.win32 }),
    'C:\\repo\\bin\\native\\win32-x64\\aih-server.exe'
  );
});

function crashableChildFactory() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 5000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('exit', 0, 'SIGTERM')); };
    children.push(child);
    return child;
  };
  return { children, spawn };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    async fire() {
      const timer = pending.shift();
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return timer.delay;
    }
  };
}

test('supervisor restarts a crashed Go Core with exponential backoff and logs its output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-core-restart-'));
  const binaryPath = path.join(tempDir, 'aih-server');
  fs.writeFileSync(binaryPath, 'placeholder');
  const { children, spawn } = crashableChildFactory();
  const timers = fakeTimers();
  let clock = 1_000;
  try {
    const supervisor = createGoCoreSupervisor({
      enabled: true,
      fs,
      path,
      // 占位二进制没有 build stamp；构件校验由专门的用例覆盖。
      verifyBuild: false,
      binaryPath,
      aiHomeDir: tempDir,
      managementKey: 'management-secret',
      clientKey: 'client-secret',
      processObj: { env: {}, kill() {} },
      spawn,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => clock,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, service: 'aih-server' }) })
    });

    await supervisor.start();
    children[0].stderr.emit('data', Buffer.from('listening on private endpoint\n'));
    children[0].emit('exit', 2, null);

    assert.equal(supervisor.status().state, 'failed');
    assert.equal(supervisor.status().restartPending, true);
    assert.equal(await timers.fire(), 1000);
    assert.equal(supervisor.status().state, 'ready');
    assert.equal(supervisor.status().restarts, 1);
    assert.equal(children.length, 2);

    // 起来即崩：退避翻倍，而不是每秒重启。
    children[1].emit('exit', 2, null);
    assert.equal(timers.pending[0].delay, 2000);
    await timers.fire();
    // 稳定服务超过门限后再崩，退避清零。
    clock += 120_000;
    children[2].emit('exit', 2, null);
    assert.equal(timers.pending[0].delay, 1000);

    const logText = fs.readFileSync(path.join(tempDir, 'logs', 'go-core.log'), 'utf8');
    assert.match(logText, /\[stderr\] listening on private endpoint/);
    assert.match(logText, /\[supervisor\] Go Core exited code=2/);
    assert.equal(logText.includes('management-secret'), false);

    // 显式 stop 取消待定的重启，也不会因子进程退出再排队。
    await supervisor.stop({ timeoutMs: 50 });
    assert.equal(timers.pending.length, 0);
    assert.equal(supervisor.status().state, 'stopped');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor does not restart when auto restart is disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-core-norestart-'));
  const binaryPath = path.join(tempDir, 'aih-server');
  fs.writeFileSync(binaryPath, 'placeholder');
  const { children, spawn } = crashableChildFactory();
  const timers = fakeTimers();
  try {
    const supervisor = createGoCoreSupervisor({
      enabled: true,
      fs,
      path,
      // 占位二进制没有 build stamp；构件校验由专门的用例覆盖。
      verifyBuild: false,
      binaryPath,
      aiHomeDir: tempDir,
      managementKey: 'management-secret',
      clientKey: 'client-secret',
      processObj: { env: {}, kill() {} },
      spawn,
      autoRestart: false,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, service: 'aih-server' }) })
    });
    await supervisor.start();
    children[0].emit('exit', 1, null);
    assert.equal(timers.pending.length, 0);
    assert.equal(supervisor.status().state, 'failed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor refuses a Go Core binary without a matching build stamp', async () => {
  const { writeBuildStamp, computeRouteManifestHash, readPackageVersion } = require('../lib/cli/services/server/go-core-build-stamp');
  const repositoryRoot = path.join(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-core-stamp-'));
  const binaryPath = path.join(tempDir, 'aih-server');
  fs.writeFileSync(binaryPath, 'binary-v1');
  const { spawn } = crashableChildFactory();
  const make = () => createGoCoreSupervisor({
    enabled: true,
    fs,
    path,
    binaryPath,
    repositoryRoot,
    aiHomeDir: tempDir,
    managementKey: 'management-secret',
    clientKey: 'client-secret',
    processObj: { env: {}, kill() {} },
    spawn,
    autoRestart: false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, service: 'aih-server' }) })
  });
  const stampFor = (overrides = {}) => writeBuildStamp(fs, {
    binaryPath,
    version: readPackageVersion(fs, repositoryRoot),
    routeManifestHash: computeRouteManifestHash(fs, repositoryRoot),
    ...overrides
  });
  try {
    await assert.rejects(() => make().start(), (error) => error.code === 'go_core_build_unverified');

    stampFor({ version: '0.0.0-old' });
    await assert.rejects(() => make().start(), (error) => error.code === 'go_core_build_mismatch');

    stampFor({ routeManifestHash: 'stale' });
    await assert.rejects(() => make().start(), (error) => error.code === 'go_core_build_mismatch');

    stampFor();
    fs.writeFileSync(binaryPath, 'binary-swapped');
    const swapped = make();
    await assert.rejects(() => swapped.start(), (error) => error.code === 'go_core_build_mismatch');
    assert.equal(swapped.status().state, 'failed');

    stampFor();
    const verified = await make().start();
    assert.equal(verified.state, 'ready');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Go Core delegates OAuth refresh to Node only when asked', () => {
  const base = {
    binaryPath: '/tmp/aih-server',
    aiHomeDir: '/tmp/aih-home',
    managementKey: 'management-secret',
    clientKey: 'client-secret',
    baseEnv: { PATH: '/usr/bin', AIH_SERVER_CREDENTIAL_REFRESH: 'delegated' }
  };
  assert.equal(buildGoCoreInvocation({ ...base, delegateCredentialRefresh: true }).env.AIH_SERVER_CREDENTIAL_REFRESH, 'delegated');
  // 继承的环境值不能让未开启同步的 Go 误以为有人替它刷新。
  assert.equal('AIH_SERVER_CREDENTIAL_REFRESH' in buildGoCoreInvocation(base).env, false);
});
