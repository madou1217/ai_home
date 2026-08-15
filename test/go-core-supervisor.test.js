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

test('enabled supervisor starts only after private readyz and stops its child', async () => {
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
      processObj: {
        env: { PATH: '/usr/bin' },
        kill: (pid, signal) => killed.push({ pid, signal })
      },
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        return child;
      },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:19550/readyz');
        assert.equal(options.headers.authorization, 'Bearer client-secret');
        return {
          ok: true,
          json: async () => ({ service: 'aih-server', ready: true })
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
    assert.deepEqual(spawned[0].options.stdio, ['ignore', 'ignore', 'ignore']);

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
