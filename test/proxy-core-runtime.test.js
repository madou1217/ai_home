'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const RUNTIME_MODULE = '../lib/cli/services/toolkit/proxy-pool/mihomo-runtime';
const COMPILER_MODULE = '../lib/cli/services/toolkit/proxy-pool/mihomo-config-compiler';

function loadRuntimeModule() {
  return require(RUNTIME_MODULE);
}

function loadCompilerModule() {
  return require(COMPILER_MODULE);
}

function createMemoryFs() {
  const files = new Map();
  const directories = new Set(['/']);

  function modeFromOptions(options) {
    if (options && typeof options === 'object' && Number.isInteger(options.mode)) {
      return options.mode;
    }
    return undefined;
  }

  return {
    existsSync(targetPath) {
      return files.has(targetPath) || directories.has(targetPath);
    },
    mkdirSync(targetPath) {
      directories.add(targetPath);
    },
    writeFileSync(targetPath, content, options) {
      files.set(targetPath, {
        content: String(content),
        mode: modeFromOptions(options) ?? files.get(targetPath)?.mode ?? 0o666
      });
    },
    readFileSync(targetPath) {
      const entry = files.get(targetPath);
      if (!entry) {
        const error = new Error(`ENOENT: ${targetPath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return entry.content;
    },
    renameSync(sourcePath, targetPath) {
      const entry = files.get(sourcePath);
      if (!entry) {
        const error = new Error(`ENOENT: ${sourcePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.set(targetPath, entry);
      files.delete(sourcePath);
    },
    chmodSync(targetPath, mode) {
      const entry = files.get(targetPath);
      if (!entry) {
        const error = new Error(`ENOENT: ${targetPath}`);
        error.code = 'ENOENT';
        throw error;
      }
      entry.mode = mode;
    },
    unlinkSync(targetPath) {
      files.delete(targetPath);
    },
    statSync(targetPath) {
      const entry = files.get(targetPath);
      if (entry) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          mode: entry.mode
        };
      }
      if (directories.has(targetPath)) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          mode: 0o755
        };
      }
      const error = new Error(`ENOENT: ${targetPath}`);
      error.code = 'ENOENT';
      throw error;
    },
    listFiles() {
      return Array.from(files.entries()).map(([filePath, entry]) => ({
        path: filePath,
        content: entry.content,
        mode: entry.mode
      }));
    }
  };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };
  return child;
}

function proxyState() {
  return {
    mixedPort: 10800,
    nodes: [
      {
        id: 'node_ss_hk',
        name: 'HK SS',
        protocol: 'shadowsocks',
        server: '198.51.100.20',
        port: 8388,
        cipher: 'aes-256-gcm',
        password: 'secret'
      }
    ],
    routing: {
      mode: 'global',
      activeOutboundNodeId: 'node_ss_hk',
      rules: []
    },
    dedicatedPorts: {
      enabled: true,
      maxPorts: 32,
      basePort: 10801,
      mappings: {
        node_ss_hk: 10801
      }
    }
  };
}

function createRuntimeHarness({ installed = true, validationOk = true, ready = true } = {}) {
  const fs = createMemoryFs();
  const spawnCalls = [];
  const spawnSyncCalls = [];
  const requestCalls = [];
  const child = createFakeChild();

  const dependencies = {
    aiHomeDir: '/virtual/aih',
    env: {},
    fs,
    path: path.posix,
    resolveCommandPath(command) {
      assert.equal(command, 'mihomo');
      return installed ? '/virtual/bin/mihomo' : '';
    },
    spawnSync(command, args, options) {
      spawnSyncCalls.push({ command, args: [...args], options });
      if (args.includes('-t')) {
        return validationOk
          ? { status: 0, stdout: 'configuration file is valid\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'configuration file is invalid\n' };
      }
      return { status: 0, stdout: 'Mihomo Meta v1.19.0\n', stderr: '' };
    },
    spawn(command, args, options) {
      spawnCalls.push({ command, args: [...args], options });
      return child;
    },
    async requestImpl(url, options) {
      requestCalls.push({ url, options });
      return {
        statusCode: 200,
        body: {
          async json() {
            return {};
          },
          async text() {
            return '';
          }
        }
      };
    },
    async readinessProbe() {
      return ready;
    },
    controllerPort: 19090,
    controllerSecret: 'test-controller-secret'
  };

  return {
    dependencies,
    fs,
    child,
    spawnCalls,
    spawnSyncCalls,
    requestCalls
  };
}

test('Mihomo config compiler binds the shared and dedicated listeners to loopback only', () => {
  const { compileMihomoConfig } = loadCompilerModule();

  const compiled = compileMihomoConfig(proxyState());

  assert.equal(compiled.config['mixed-port'], 10800);
  assert.equal(compiled.config['bind-address'], '127.0.0.1');
  assert.equal(compiled.config['allow-lan'], false);
  assert.equal(compiled.exportedNodeCount, 1);
  assert.ok(compiled.activeListeners.some((listener) => (
    listener.nodeId === 'node_ss_hk' && listener.port === 10801
  )));
});

test('Mihomo runtime reports an unavailable data plane without probing or spawning when the binary is not installed', () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness({ installed: false });
  const runtime = new MihomoRuntime(harness.dependencies);

  const status = runtime.getStatus();

  assert.equal(status.engine, 'mihomo');
  assert.equal(status.installed, false);
  assert.equal(status.running, false);
  assert.equal(status.dataPlaneReady, false);
  assert.equal(status.binaryName, null);
  assert.equal(status.version, null);
  assert.equal(status.mixedProxyUrl, null);
  assert.deepEqual(status.activeListeners, []);
  assert.equal(status.lastError, null);
  assert.deepEqual(harness.spawnCalls, []);
  assert.deepEqual(harness.requestCalls, []);
});

test('Mihomo runtime writes a private loopback-only config before starting the data plane', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);

  const result = await runtime.start(proxyState());

  assert.equal(result.ok, true);
  assert.equal(result.action, 'start');
  assert.equal(result.applied, true);
  assert.equal(result.core.engine, 'mihomo');
  assert.equal(result.core.running, true);
  assert.equal(result.core.dataPlaneReady, true);
  assert.equal(result.core.mixedProxyUrl, 'http://127.0.0.1:10800');
  assert.deepEqual(result.warnings, []);
  assert.equal(harness.spawnCalls.length, 1);

  const configFiles = harness.fs.listFiles().filter((file) => (
    file.content.includes('mixed-port') && file.content.includes('127.0.0.1')
  ));
  assert.equal(configFiles.length, 1);
  assert.equal(configFiles[0].mode & 0o777, 0o600);
  assert.match(configFiles[0].content, /allow-lan:\s*false/);
});

test('Mihomo runtime does not spawn when config validation fails', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness({ validationOk: false });
  const runtime = new MihomoRuntime(harness.dependencies);

  const result = await runtime.start(proxyState());

  assert.equal(result.ok, false);
  assert.equal(result.action, 'start');
  assert.equal(result.applied, false);
  assert.equal(result.core.running, false);
  assert.equal(result.core.dataPlaneReady, false);
  assert.equal(result.core.mixedProxyUrl, null);
  assert.ok(result.error || result.message);
  assert.equal(harness.spawnSyncCalls.some((call) => call.args.includes('-t')), true);
  assert.deepEqual(harness.spawnCalls, []);
});

test('Mihomo runtime stop clears running and data-plane-ready state', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);
  const started = await runtime.start(proxyState());
  assert.equal(started.ok, true);

  const stopped = await runtime.stop();

  assert.equal(stopped.ok, true);
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.applied, true);
  assert.equal(stopped.core.engine, 'mihomo');
  assert.equal(stopped.core.running, false);
  assert.equal(stopped.core.dataPlaneReady, false);
  assert.equal(stopped.core.mixedProxyUrl, null);
  assert.deepEqual(stopped.core.activeListeners, []);
  assert.deepEqual(stopped.warnings, []);
});

test('Mihomo runtime exposes only its owned child pid for network ownership checks', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);

  assert.equal(runtime.getOwnedProcessId(), null);
  assert.equal((await runtime.start(proxyState())).ok, true);
  assert.equal(runtime.getOwnedProcessId(), 4242);
  await runtime.stop();
  assert.equal(runtime.getOwnedProcessId(), null);
});

test('Mihomo runtime exposes a stable semantic version instead of raw command output', () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);

  assert.equal(runtime.getStatus().version, '1.19.0');
});

test('Mihomo runtime does not claim readiness when a configured listener is unavailable', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  harness.dependencies.listenerProbe = async (port) => port === 10800;
  const runtime = new MihomoRuntime(harness.dependencies);

  const result = await runtime.start(proxyState());

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_readiness_failed');
  assert.equal(result.core.dataPlaneReady, false);
  assert.equal(result.core.mixedProxyUrl, null);
  assert.deepEqual(result.core.activeListeners, []);
});

test('Mihomo runtime serializes concurrent reload operations', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);
  assert.equal((await runtime.start(proxyState())).ok, true);

  const releases = [];
  runtime.requestImpl = async () => new Promise((resolve) => {
    releases.push(() => resolve({
      statusCode: 204,
      body: { async text() { return ''; } }
    }));
  });

  const first = runtime.reload(proxyState());
  const second = runtime.reload({
    ...proxyState(),
    routing: { mode: 'direct', activeOutboundNodeId: null, rules: [] }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  assert.equal((await first).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  assert.equal((await second).ok, true);
});

test('Mihomo runtime reapplies the previous config when a reload request has an ambiguous transport failure', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const runtime = new MihomoRuntime(harness.dependencies);
  assert.equal((await runtime.start(proxyState())).ok, true);
  const previousConfig = harness.fs.readFileSync(runtime.configPath);

  let reloadRequests = 0;
  runtime.requestImpl = async () => {
    reloadRequests += 1;
    if (reloadRequests === 1) throw new Error('connection reset after request write');
    return {
      statusCode: 204,
      body: { async text() { return ''; } }
    };
  };

  const result = await runtime.reload({
    ...proxyState(),
    routing: { mode: 'direct', activeOutboundNodeId: null, rules: [] }
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(reloadRequests, 2);
  assert.equal(harness.fs.readFileSync(runtime.configPath), previousConfig);
});

test('Mihomo runtime does not report stopped when the child ignores termination signals', async () => {
  const { MihomoRuntime } = loadRuntimeModule();
  const harness = createRuntimeHarness();
  const signals = [];
  const child = createFakeChild();
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const runtime = new MihomoRuntime({
    ...harness.dependencies,
    terminateTimeoutMs: 5,
    killTimeoutMs: 5
  });
  runtime.child = child;
  runtime.ready = true;

  const result = await runtime.stop();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_stop_failed');
  assert.equal(result.core.running, true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
