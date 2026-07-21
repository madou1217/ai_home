const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  hasSecretBearingArgument,
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState,
  removeBackgroundComponent,
  upsertBackgroundComponent
} = require('../lib/cli/services/background/supervisor-state-store');
const {
  runBackgroundSupervisor
} = require('../lib/cli/services/background/supervisor-runtime');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-background-supervisor-'));
}

test('background supervisor state keeps one desired-state registry and derives the server dependency', (t) => {
  const aiHomeDir = makeTempDir();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertBackgroundComponent({
    id: 'node-relay:nat-node',
    args: ['node', 'relay', 'connect', 'https://control.example.com', '--node-id', 'nat-node'],
    logFile: path.join(aiHomeDir, 'logs', 'services', 'node-relay-nat-node.log')
  }, deps);

  const stored = readBackgroundSupervisorState(deps);
  assert.deepEqual(Object.keys(stored.components), ['node-relay:nat-node']);
  assert.equal('logFile' in stored.components['node-relay:nat-node'], false);
  assert.equal(JSON.stringify(stored).includes('management-secret'), false);
  assert.deepEqual(
    listEffectiveBackgroundComponents(stored, { aiHomeDir }).map((component) => component.id),
    ['server', 'node-relay:nat-node']
  );

  removeBackgroundComponent('node-relay:nat-node', deps);
  assert.deepEqual(readBackgroundSupervisorState(deps).components, {});

  assert.throws(() => upsertBackgroundComponent({
    id: 'node-relay:unsafe',
    args: [
      'node',
      'relay',
      'connect',
      'https://control.example.com',
      '--management-key',
      'must-not-be-persisted'
    ]
  }, deps), { code: 'invalid_background_component' });
});

test('background supervisor state rejects credentials embedded in component URLs', (t) => {
  const aiHomeDir = makeTempDir();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, path, aiHomeDir };
  const secretUrls = [
    'https://relay-user:relay-password@control.example.com',
    'https://control.example.com?token=secret-token',
    'https://control.example.com?api_key=secret-api-key',
    'https://control.example.com?management-key=secret-management-key',
    'https://control.example.com?accessToken=secret-access-token',
    'https://control.example.com?bearerToken=secret-bearer-token',
    'https://control.example.com?X-Amz-Credential=secret-credential'
  ];

  for (const [index, controlUrl] of secretUrls.entries()) {
    const args = ['node', 'relay', 'connect', controlUrl, '--node-id', `node-${index}`];
    assert.equal(hasSecretBearingArgument(args), true, controlUrl);
    assert.throws(() => upsertBackgroundComponent({
      id: `node-relay:node-${index}`,
      args
    }, deps), { code: 'invalid_background_component' });
  }

  assert.equal(hasSecretBearingArgument([
    'node',
    'relay',
    'connect',
    'https://control.example.com?region=ap-northeast-1',
    '--node-id',
    'safe-node'
  ]), false);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'run', 'background-supervisor.json')), false);
});

test('background supervisor state rejects secrets embedded in composite transport targets', (t) => {
  const aiHomeDir = makeTempDir();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, path, aiHomeDir };
  const unsafeComponents = [
    {
      id: 'fabric-registry-agent:split-probe',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'split-probe',
        '--probe-transport',
        'relay=https://relay.example.com/path?token=split-secret'
      ]
    },
    {
      id: 'fabric-registry-agent:inline-probe',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'inline-probe',
        '--probe-transport=relay=https://relay.example.com/path?api_key=inline-secret'
      ]
    },
    {
      id: 'fabric-registry-agent:transport-last-error',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'transport-last-error',
        '--transport',
        'relay=degraded,https://probe.example.com/path?token=last-error-secret'
      ]
    },
    {
      id: 'fabric-registry-agent:comma-secret-tail',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'comma-secret-tail',
        '--transport',
        'relay=degraded,token=comma-tail-secret'
      ]
    },
    {
      id: 'fabric-registry-agent:ampersand-secret-tail',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'ampersand-secret-tail',
        '--transport',
        'relay=degraded&token=ampersand-tail-secret'
      ]
    },
    {
      id: 'fabric-registry-agent:semicolon-secret-tail',
      args: [
        'fabric',
        'registry',
        'agent',
        'https://control.example.com',
        '--node-id',
        'semicolon-secret-tail',
        '--transport',
        'relay=degraded;token=semicolon-tail-secret'
      ]
    }
  ];

  for (const component of unsafeComponents) {
    assert.equal(hasSecretBearingArgument(component.args), true, component.id);
    assert.throws(
      () => upsertBackgroundComponent(component, deps),
      { code: 'invalid_background_component' }
    );
  }

  assert.equal(hasSecretBearingArgument([
    '--probe-transport',
    'relay=https://relay.example.com/path?region=ap-northeast-1'
  ]), false);
  assert.equal(hasSecretBearingArgument([
    '--transport',
    'relay=degraded,connection-timeout'
  ]), false);
  assert.equal(hasSecretBearingArgument([
    '--transport',
    'relay=online,remote-request-ready=true,mode=management-rpc,evidence-ref=https://probe.example.com/path?region=ap-northeast-1'
  ]), false);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'run', 'background-supervisor.json')), false);
});

test('background supervisor state fails closed when persisted JSON is malformed', (t) => {
  const aiHomeDir = makeTempDir();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const stateFile = path.join(aiHomeDir, 'run', 'background-supervisor.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, 'secret-token-is-not-json');

  assert.throws(
    () => readBackgroundSupervisorState({ fs, path, aiHomeDir }),
    (error) => error
      && error.code === 'background_supervisor_state_invalid'
      && error.message === 'background_supervisor_state_invalid'
      && error.cause === undefined
  );
});

test('background supervisor state fails closed when an existing file cannot be read', () => {
  const readError = new Error('permission denied');
  readError.code = 'EACCES';
  const fsImpl = {
    existsSync() { return true; },
    readFileSync() { throw readError; }
  };

  assert.throws(
    () => readBackgroundSupervisorState({ fs: fsImpl, path, aiHomeDir: '/tmp/.ai_home' }),
    (error) => error
      && error.code === 'background_supervisor_state_read_failed'
      && error.message === 'background_supervisor_state_read_failed'
  );
});

test('background supervisor state fails closed when persisted components are unsafe', (t) => {
  const aiHomeDir = makeTempDir();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const stateFile = path.join(aiHomeDir, 'run', 'background-supervisor.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 1,
    components: {
      'node-relay:unsafe': {
        id: 'node-relay:unsafe',
        args: [
          'node',
          'relay',
          'connect',
          'https://control.example.com?refresh_token=secret-token',
          '--node-id',
          'unsafe'
        ]
      }
    }
  }));

  assert.throws(
    () => readBackgroundSupervisorState({ fs, path, aiHomeDir }),
    { code: 'background_supervisor_state_invalid' }
  );
});

test('background supervisor runs every component in one process and forwards shutdown', async () => {
  const processObj = new EventEmitter();
  processObj.env = {
    PATH: '/usr/local/bin:/usr/bin',
    AIH_MANAGEMENT_KEY: 'must-not-be-shared-between-nodes'
  };
  processObj.execPath = '/usr/local/bin/node';
  processObj.argv = ['/usr/local/bin/node', '/opt/homebrew/bin/aih', '__background', 'run'];
  processObj.pid = 8123;
  const calls = [];
  const stopped = [];

  function waitForAbort(kind, args, deps) {
    calls.push({ kind, args, processObj: deps.processObj, signal: deps.signal, env: deps.env });
    return new Promise((resolve) => {
      if (deps.signal.aborted) {
        resolve();
        return;
      }
      deps.signal.addEventListener('abort', resolve, { once: true });
    });
  }

  const running = runBackgroundSupervisor({
    fs,
    processObj,
    aiHomeDir: '/tmp/.ai_home',
    resolveServerOptions: () => ({
      host: '127.0.0.1',
      port: 9527,
      clientKey: 'client-secret',
      managementKey: 'management-secret'
    }),
    startLocalServer: async (options) => {
      calls.push({ kind: 'server', options, processObj });
      return {
        async stop(signal) {
          stopped.push(signal);
        }
      };
    },
    runNodeRelayConnect: (args, deps) => waitForAbort('relay', args, deps),
    runNodeWebrtcConnect: (args, deps) => waitForAbort('webrtc', args, deps),
    runFabricRegistryAgent: (args, deps) => waitForAbort('registry', args, deps),
    readState: () => ({
      schemaVersion: 1,
      components: {
        'node-relay:nat-node': {
          id: 'node-relay:nat-node',
          args: ['node', 'relay', 'connect', 'https://control.example.com', '--node-id', 'nat-node'],
          logFile: ''
        },
        'fabric-registry-agent:nat-node': {
          id: 'fabric-registry-agent:nat-node',
          args: ['fabric', 'registry', 'agent', 'https://control.example.com', '--node-id', 'nat-node'],
          logFile: ''
        },
        'node-webrtc:nat-node': {
          id: 'node-webrtc:nat-node',
          args: ['node', 'webrtc', 'connect', 'https://control.example.com', '--node-id', 'nat-node']
        }
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].kind, 'server');
  assert.equal(calls[0].options.manageProcessLifecycle, false);
  assert.equal(calls[0].options.clientKey, 'client-secret');
  assert.equal(calls[0].options.managementKey, 'management-secret');
  assert.deepEqual(calls.find((call) => call.kind === 'relay').args, [
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ]);
  assert.deepEqual(calls.find((call) => call.kind === 'registry').args, [
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ]);
  assert.deepEqual(calls.find((call) => call.kind === 'webrtc').args, [
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ]);
  assert.equal(calls.find((call) => call.kind === 'registry').env.AIH_MANAGEMENT_KEY, undefined);
  assert.equal(calls.every((call) => call.processObj === processObj), true);

  processObj.emit('SIGTERM');
  await running;

  assert.deepEqual(stopped, ['SIGTERM']);
  assert.equal(calls.filter((call) => call.signal).every((call) => call.signal.aborted), true);
});

test('background supervisor restarts only a failed in-process worker', async () => {
  const processObj = new EventEmitter();
  processObj.env = {};
  processObj.pid = 8124;
  const restartCallbacks = [];
  const relaySignals = [];
  let relayRuns = 0;

  const running = runBackgroundSupervisor({
    fs,
    processObj,
    aiHomeDir: '/tmp/.ai_home',
    resolveServerOptions: () => ({ host: '127.0.0.1', port: 9527 }),
    startLocalServer: async () => ({ stop: async () => {} }),
    runNodeRelayConnect: (_args, deps) => {
      relayRuns += 1;
      relaySignals.push(deps.signal);
      if (relayRuns === 1) return Promise.reject(new Error('relay_failed'));
      return new Promise((resolve) => deps.signal.addEventListener('abort', resolve, { once: true }));
    },
    readState: () => ({
      schemaVersion: 1,
      components: {
        'node-relay:nat-node': {
          id: 'node-relay:nat-node',
          args: ['node', 'relay', 'connect', 'https://control.example.com', '--node-id', 'nat-node'],
          logFile: ''
        }
      }
    }),
    setTimeout(callback) {
      restartCallbacks.push(callback);
      return { unref() {} };
    },
    clearTimeout() {}
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relayRuns, 1);
  assert.equal(restartCallbacks.length, 1);
  restartCallbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relayRuns, 2);

  processObj.emit('SIGTERM');
  await running;
  assert.equal(relaySignals.every((signal) => signal.aborted), true);
});

test('background supervisor fails the process boundary when its server closes unexpectedly', async () => {
  const processObj = new EventEmitter();
  processObj.env = {};
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const stopReasons = [];

  const running = runBackgroundSupervisor({
    fs,
    processObj,
    aiHomeDir: '/tmp/.ai_home',
    resolveServerOptions: () => ({ host: '127.0.0.1', port: 9527 }),
    startLocalServer: async () => ({
      closed,
      async stop(reason) {
        stopReasons.push(reason);
      }
    }),
    readState: () => ({
      schemaVersion: 1,
      components: {
        server: { id: 'server', args: ['server', 'serve'] }
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  resolveClosed();

  await assert.rejects(running, { code: 'background_server_stopped' });
  assert.deepEqual(stopReasons, ['server-closed']);
});

test('background supervisor keeps invalid worker credentials blocked without a restart storm', async () => {
  const processObj = new EventEmitter();
  processObj.env = {};
  const restartCallbacks = [];
  const error = new Error('relay_http_401');
  error.code = 'relay_upgrade_rejected';
  error.statusCode = 401;

  const running = runBackgroundSupervisor({
    fs,
    processObj,
    consoleImpl: { error() {}, warn() {}, log() {} },
    aiHomeDir: '/tmp/.ai_home',
    resolveServerOptions: () => ({ host: '127.0.0.1', port: 9527 }),
    startLocalServer: async () => ({ stop: async () => {} }),
    runNodeRelayConnect: async () => { throw error; },
    readState: () => ({
      schemaVersion: 1,
      components: {
        'node-relay:nat-node': {
          id: 'node-relay:nat-node',
          args: ['node', 'relay', 'connect', 'https://control.example.com', '--node-id', 'nat-node']
        }
      }
    }),
    setTimeout(callback) {
      restartCallbacks.push(callback);
      return { unref() {} };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(restartCallbacks, []);
  processObj.emit('SIGTERM');
  await running;
});

test('background supervisor stops the server immediately and bounds a stuck worker shutdown', async () => {
  const processObj = new EventEmitter();
  processObj.env = {};
  let resolveShutdownDeadline = null;
  let serverStops = 0;

  const running = runBackgroundSupervisor({
    fs,
    processObj,
    consoleImpl: { error() {}, warn() {}, log() {} },
    aiHomeDir: '/tmp/.ai_home',
    shutdownTimeoutMs: 25,
    setShutdownTimeout(callback) {
      resolveShutdownDeadline = callback;
      return { unref() {} };
    },
    clearShutdownTimeout() {},
    resolveServerOptions: () => ({ host: '127.0.0.1', port: 9527 }),
    startLocalServer: async () => ({
      async stop() {
        serverStops += 1;
      }
    }),
    runNodeRelayConnect: () => new Promise(() => {}),
    readState: () => ({
      schemaVersion: 1,
      components: {
        'node-relay:nat-node': {
          id: 'node-relay:nat-node',
          args: ['node', 'relay', 'connect', 'https://control.example.com', '--node-id', 'nat-node']
        }
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  processObj.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(serverStops, 1);
  assert.equal(typeof resolveShutdownDeadline, 'function');
  resolveShutdownDeadline();
  await running;
});
