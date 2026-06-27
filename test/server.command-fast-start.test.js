'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runServerCommand } = require('../lib/server/command-handler');
const { runServerCommandRouter } = require('../lib/cli/commands/server-router');

async function captureConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('runServerCommand config shows redacted server config', async () => {
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand(['server', 'config'], {
    showServerUsage() {},
    serverDaemon: {},
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({
      host: '0.0.0.0',
      port: 9530,
      apiKey: 'client-secret',
      managementKey: 'management-secret',
      openNetwork: true,
      proxyUrl: '',
      noProxy: '',
      modelsProbeAccounts: 3
    }),
    writeServerConfig: () => {
      throw new Error('should not write');
    },
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output, /host: 0\.0\.0\.0/);
  assert.match(output, /api_key: configured/);
  assert.match(output, /management_key: configured/);
  assert.doesNotMatch(output, /client-secret/);
  assert.doesNotMatch(output, /management-secret/);
});

test('runServerCommand config set writes patch and reports restart requirement', async () => {
  let written = null;
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand([
    'server',
    'config',
    'set',
    '--open-network',
    '--client-key',
    'client-secret',
    '--management-key=management-secret',
    '--port',
    '9530',
    '--models-probe-accounts',
    '4'
  ], {
    showServerUsage() {},
    serverDaemon: {},
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: '', managementKey: '', openNetwork: false }),
    writeServerConfig: (patch) => {
      written = patch;
      return {
        host: '0.0.0.0',
        port: 9530,
        apiKey: patch.apiKey,
        managementKey: patch.managementKey,
        openNetwork: patch.openNetwork,
        proxyUrl: '',
        noProxy: '',
        modelsProbeAccounts: patch.modelsProbeAccounts
      };
    },
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(written, {
    openNetwork: true,
    apiKey: 'client-secret',
    managementKey: 'management-secret',
    port: 9530,
    modelsProbeAccounts: 4
  });
  assert.match(output, /server config saved; run `aih server restart` to apply it/);
  assert.doesNotMatch(output, /client-secret/);
  assert.doesNotMatch(output, /management-secret/);
});

test('runServerCommand serve reads sensitive keys from server config without argv', async () => {
  let startedOptions = null;
  const { result: code, errors } = await captureConsole(() => runServerCommand([
    'server',
    'serve',
    '--host',
    '0.0.0.0',
    '--port',
    '9530'
  ], {
    showServerUsage() {},
    serverDaemon: {},
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({
      host: '0.0.0.0',
      port: 9530,
      clientKey: '',
      clientKeySource: '',
      managementKey: '',
      proxyUrl: '',
      noProxy: ''
    }),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({
      host: '0.0.0.0',
      port: 9530,
      apiKey: 'client-secret',
      managementKey: 'management-secret',
      openNetwork: true,
      proxyUrl: 'http://127.0.0.1:6152',
      noProxy: 'localhost'
    }),
    writeServerConfig: () => {
      throw new Error('should not write');
    },
    startLocalServer: async (options) => {
      startedOptions = options;
    },
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  assert.equal(code, null);
  assert.deepEqual(errors, []);
  assert.equal(startedOptions.clientKey, 'client-secret');
  assert.equal(startedOptions.clientKeySource, 'server-config');
  assert.equal(startedOptions.managementKey, 'management-secret');
  assert.equal(startedOptions.proxyUrl, 'http://127.0.0.1:6152');
  assert.equal(startedOptions.noProxy, 'localhost');
});

test('runServerCommand config set can generate management key without printing it', async () => {
  let written = null;
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand([
    'server',
    'config',
    'set',
    '--generate-management-key',
    '--port',
    '9527'
  ], {
    showServerUsage() {},
    serverDaemon: {},
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: '', managementKey: '', openNetwork: false }),
    writeServerConfig: (patch) => {
      written = patch;
      return {
        host: '127.0.0.1',
        port: patch.port,
        apiKey: '',
        managementKey: patch.managementKey,
        openNetwork: false,
        proxyUrl: '',
        noProxy: '',
        modelsProbeAccounts: 2
      };
    },
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 }),
    generateManagementKey: () => 'generated-management-secret'
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(written, {
    managementKey: 'generated-management-secret',
    port: 9527
  });
  assert.match(output, /management_key: configured/);
  assert.doesNotMatch(output, /generated-management-secret/);
});

test('runServerCommand starts daemon in non-blocking mode', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'start'], {
    showServerUsage() {},
    serverDaemon: {
      start: async (rawServeArgs, startOptions) => {
        calls.push({ rawServeArgs, startOptions });
        return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 1234 };
      },
      stop: () => ({ stopped: false, reason: 'not_running' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    rawServeArgs: [],
    startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
  }]);
});

test('runServerCommand start reports configured server api key without exposing it', async () => {
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand(['server', 'start'], {
    showServerUsage() {},
    serverDaemon: {
      start: async () => ({ alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 1234 })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: 'client-secret' }),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output, /api_key: configured/);
  assert.doesNotMatch(output, /api_key: dummy/);
  assert.doesNotMatch(output, /client-secret/);
});

test('runServerCommand restarts daemon in non-blocking mode after stop', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'restart'], {
    showServerUsage() {},
    serverDaemon: {
      restart: async (rawServeArgs, restartOptions) => {
        calls.push({ rawServeArgs, restartOptions });
        return {
          alreadyRunning: false,
          started: true,
          ready: false,
          state: 'starting',
          pid: 5678,
          stoppedForRestart: { stopped: true, pid: 1111 }
        };
      },
      start: async () => ({}),
      stop: () => ({ stopped: false, reason: 'not_used' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    rawServeArgs: [],
    restartOptions: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
  }]);
});

test('runServerCommand restart reports missing server api key when config has none', async () => {
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand(['server', 'restart'], {
    showServerUsage() {},
    serverDaemon: {
      restart: async () => ({
        alreadyRunning: false,
        started: true,
        ready: false,
        state: 'starting',
        pid: 5678,
        stoppedForRestart: { stopped: true, pid: 1111 }
      }),
      start: async () => ({}),
      stop: () => ({ stopped: false, reason: 'not_used' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: '' }),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output, /api_key: missing/);
  assert.doesNotMatch(output, /api_key: dummy/);
});

test('runServerCommand restart rejects serve options', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'restart', '--port', '9527'], {
    showServerUsage() {},
    serverDaemon: {
      restart: async (rawServeArgs, restartOptions) => {
        calls.push({ rawServeArgs, restartOptions });
        return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 5678 };
      },
      start: async (rawServeArgs, startOptions) => {
        calls.push({ rawServeArgs, startOptions });
        return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 5678 };
      },
      stop: (stopOptions) => {
        calls.push({ stopOptions });
        return { stopped: true, pid: 1111 };
      },
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({ port: 9527 }),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('runServerCommand status rejects serve options', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'status', '--port', '9527'], {
    showServerUsage() {},
    serverDaemon: {
      start: async () => ({}),
      stop: () => ({ stopped: false, reason: 'not_running' }),
      status: () => {
        calls.push('status_called');
        return { running: false };
      },
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({ port: 9527 }),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('runServerCommand start rejects serve options', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'start', '--port', '9527'], {
    showServerUsage() {},
    serverDaemon: {
      start: async (rawServeArgs, startOptions) => {
        calls.push({ rawServeArgs, startOptions });
        return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 5678 };
      },
      stop: () => ({ stopped: false, reason: 'not_running' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({ port: 9527 }),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('runServerCommand restarts daemon with stopped server entry path', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'restart'], {
    showServerUsage() {},
    serverDaemon: {
      restart: async (rawServeArgs, restartOptions) => {
        calls.push({ rawServeArgs, restartOptions });
        return {
          alreadyRunning: false,
          started: true,
          ready: false,
          state: 'starting',
          pid: 5678,
          entryFilePath: '/repo/lib/cli/app.js',
          stoppedForRestart: {
            stopped: true,
            pid: 1111,
            entryFilePath: '/repo/lib/cli/app.js'
          }
        };
      },
      start: async () => ({}),
      stop: () => ({ stopped: false, reason: 'not_used' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    rawServeArgs: [],
    restartOptions: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
  }]);
});

test('runServerCommand status reports stale source and restart action', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const code = await runServerCommand(['server', 'status'], {
      showServerUsage() {},
      serverDaemon: {
        start: async () => ({}),
        stop: () => ({ stopped: false, reason: 'not_running' }),
        status: () => ({
          running: true,
          pid: 2468,
          ready: true,
          stale: true,
          staleReason: 'source_changed',
          pidFile: '/tmp/aih.pid',
          logFile: '/tmp/aih.log',
          entryFilePath: '/repo/lib/cli/app.js'
        }),
        autostartStatus: () => ({ supported: false })
      },
      parseServerEnvArgs: () => ({}),
      parseServerServeArgs: () => ({}),
      parseServerSyncArgs: () => ({}),
      startLocalServer: async () => ({}),
      syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
    });

    assert.equal(code, 0);
    assert.equal(logs.some((line) => line.includes('stale: true (source_changed)')), true);
    assert.equal(logs.some((line) => line.includes('action: aih server restart')), true);
    assert.equal(logs.some((line) => line.includes('api_key: dummy')), false);
  } finally {
    console.log = originalLog;
  }
});

test('runServerCommand status reports configured server api key without exposing it', async () => {
  const { result: code, logs, errors } = await captureConsole(() => runServerCommand(['server', 'status'], {
    showServerUsage() {},
    serverDaemon: {
      status: () => ({ running: true, ready: true, state: 'running', pid: 2468, port: 9527, pidFile: '/tmp/pid', logFile: '/tmp/log' }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: 'status-secret' }),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  }));

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output, /api_key: configured/);
  assert.doesNotMatch(output, /api_key: dummy/);
  assert.doesNotMatch(output, /status-secret/);
});

test('runServerCommandRouter starts daemon in non-blocking mode', () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'start'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: () => ({ stopped: false, reason: 'not_running' }),
    startServerDaemon: async (rawServeArgs, startOptions) => {
      calls.push({ rawServeArgs, startOptions });
      return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 9012 };
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(exitCode, 0);
      assert.deepEqual(calls, [{
        rawServeArgs: [],
        startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
      }]);
      resolve();
    }, 0);
  });
});

test('runServerCommandRouter passes server config readers to config command', async () => {
  let exitCode = null;
  let written = null;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    runServerCommandRouter(['server', 'config', 'set', '--client-key', 'router-secret'], {
      processImpl: {
        exit(code) {
          exitCode = code;
        }
      },
      showServerUsage() {},
      getServerDaemonStatus: () => ({ running: false }),
      getServerAutostartStatus: () => ({ supported: false }),
      installServerAutostart() {},
      uninstallServerAutostart() {},
      stopServerDaemon: () => ({ stopped: false, reason: 'not_running' }),
      startServerDaemon: async () => ({}),
      restartServerDaemon: async () => ({}),
      parseServerEnvArgs: () => ({}),
      parseServerServeArgs: () => ({}),
      parseServerSyncArgs: () => ({}),
      readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: '', managementKey: '', openNetwork: false }),
      writeServerConfig: (patch) => {
        written = patch;
        return { host: '127.0.0.1', port: 9527, apiKey: patch.apiKey, managementKey: '', openNetwork: false };
      },
      startLocalServer: async () => ({}),
      syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = logs.join('\n');
    assert.equal(exitCode, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(written, { apiKey: 'router-secret' });
    assert.match(output, /api_key: configured/);
    assert.doesNotMatch(output, /router-secret/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('runServerCommandRouter restarts daemon in non-blocking mode', () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'restart'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: () => ({ stopped: false, reason: 'not_used' }),
    startServerDaemon: async (rawServeArgs, startOptions) => {
      calls.push({ rawServeArgs, startOptions });
      return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 2718 };
    },
    restartServerDaemon: async (rawServeArgs, restartOptions) => {
      calls.push({ rawServeArgs, restartOptions });
      return {
        alreadyRunning: false,
        started: true,
        ready: false,
        state: 'starting',
        pid: 2718,
        stoppedForRestart: { stopped: true, pid: 3141 }
      };
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(exitCode, 0);
      assert.deepEqual(calls, [{
        rawServeArgs: [],
        restartOptions: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
      }]);
      resolve();
    }, 0);
  });
});

test('runServerCommandRouter stop rejects serve options', async () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'stop', '--port', '9527'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: (stopOptions) => {
      calls.push(stopOptions);
      return { stopped: true, pid: 3141 };
    },
    startServerDaemon: async () => ({}),
    restartServerDaemon: async () => ({}),
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({ port: 9527 }),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
});

test('runServerCommandRouter start rejects serve options', async () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'start', '--port', '9527'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: () => ({ stopped: false, reason: 'not_running' }),
    startServerDaemon: async (rawServeArgs, startOptions) => {
      calls.push({ rawServeArgs, startOptions });
      return { alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 2718 };
    },
    restartServerDaemon: async () => ({}),
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({ port: 9527 }),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
});

test('runServerCommandRouter passes stopped server entry path into restart', () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'restart'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: () => ({ stopped: false, reason: 'not_used' }),
    startServerDaemon: async () => ({}),
    restartServerDaemon: async (rawServeArgs, restartOptions) => {
      calls.push({ rawServeArgs, restartOptions });
      return {
        alreadyRunning: false,
        started: true,
        ready: false,
        state: 'starting',
        pid: 2718,
        entryFilePath: '/repo/lib/cli/app.js',
        stoppedForRestart: {
          stopped: true,
          pid: 3141,
          entryFilePath: '/repo/lib/cli/app.js'
        }
      };
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(exitCode, 0);
      assert.deepEqual(calls, [{
        rawServeArgs: [],
        restartOptions: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
      }]);
      resolve();
    }, 0);
  });
});

test('runServerCommand reports already starting daemon distinctly', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const code = await runServerCommand(['server', 'start'], {
      showServerUsage() {},
      serverDaemon: {
        start: async () => ({ alreadyRunning: true, started: true, ready: false, state: 'starting', pid: 2468 }),
        stop: () => ({ stopped: false, reason: 'not_running' }),
        status: () => ({ running: true, ready: false, state: 'starting', pid: 2468 }),
        autostartStatus: () => ({ supported: false })
      },
      parseServerEnvArgs: () => ({}),
      parseServerServeArgs: () => ({}),
      parseServerSyncArgs: () => ({}),
      startLocalServer: async () => ({}),
      syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
    });

    assert.equal(code, 0);
    assert.equal(logs.some((line) => line.includes('already starting')), true);
  } finally {
    console.log = originalLog;
  }
});
