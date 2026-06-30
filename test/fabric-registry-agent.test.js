const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  discoverRuntimeDiagnostics,
  formatFabricRegistryAgentEvent,
  mergeTransportHeartbeats,
  parseFabricRegistryAgentArgs,
  parseProbeTransport,
  probeAgentTransports,
  runFabricRegistryAgent
} = require('../lib/cli/services/fabric/registry-agent');

test('parseFabricRegistryAgentArgs builds a foreground heartbeat loop config', () => {
  const options = parseFabricRegistryAgentArgs([
    'http://127.0.0.1:8317/',
    '--token',
    'device-token',
    '--node-id',
    'Office PC',
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--probe-transport',
    'relay=tcp://127.0.0.1:8317',
    '--probe-timeout-ms',
    '3000',
    '--probe-method',
    'GET',
    '--probe-count',
    '3',
    '--probe-payload-size',
    '64',
    '--runtime-diagnostics',
    '--interval-ms',
    '5000',
    '--count',
    '2',
    '--json'
  ], { env: {} });

  assert.equal(options.endpoint, 'http://127.0.0.1:8317');
  assert.equal(options.token, 'device-token');
  assert.equal(options.nodeId, 'office-pc');
  assert.equal(options.relayStatus, 'online');
  assert.deepEqual(options.transports, [
    { kind: 'relay', health: 'online', lastError: '' }
  ]);
  assert.deepEqual(options.probeTransports, [
    { kind: 'relay', target: 'tcp://127.0.0.1:8317' }
  ]);
  assert.equal(options.probeTimeoutMs, 3000);
  assert.equal(options.probeMethod, 'GET');
  assert.equal(options.probeCount, 3);
  assert.equal(options.probePayloadSize, 64);
  assert.equal(options.runtimeDiagnostics, true);
  assert.equal(options.intervalMs, 5000);
  assert.equal(options.count, 2);
  assert.equal(options.json, true);
});

test('discoverRuntimeDiagnostics records provider CLI and local readyz account facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexPath = path.join(dir, 'codex');
  fs.writeFileSync(codexPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codexPath, 0o755);

  const diagnostics = await discoverRuntimeDiagnostics({
    endpoint: 'http://127.0.0.1:9527',
    runtimeDiagnostics: true
  }, {
    env: { PATH: dir },
    projectFallback: false,
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }),
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9527/readyz');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          accounts: {
            codex: 0,
            claude: 2,
            agy: 0,
            opencode: 0
          }
        })
      };
    }
  });

  const codex = diagnostics.find((item) => item.provider === 'codex');
  const claude = diagnostics.find((item) => item.provider === 'claude');
  assert.equal(diagnostics.length, 4);
  assert.equal(codex.cli.available, true);
  assert.equal(codex.cli.path, codexPath);
  assert.equal(codex.accounts.total, 0);
  assert.equal(claude.cli.available, false);
  assert.equal(claude.accounts.total, 2);
});

test('discoverRuntimeDiagnostics uses the same app-local CLI fallback as native sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-app-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'node_modules', '.bin');
  const codexPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(codexPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(codexPath, 0o755);

  const diagnostics = await discoverRuntimeDiagnostics({
    endpoint: 'http://127.0.0.1:9527',
    runtimeDiagnostics: true
  }, {
    appRoot: root,
    env: {
      PATH: '',
      AIH_CODEX_RESOLVE_LATEST: '0'
    },
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        accounts: {
          codex: 1,
          claude: 0,
          agy: 0,
          opencode: 0
        }
      })
    })
  });

  const codex = diagnostics.find((item) => item.provider === 'codex');
  assert.equal(codex.cli.available, true);
  assert.equal(codex.cli.path, codexPath);
  assert.equal(codex.accounts.total, 1);
});

test('discoverRuntimeDiagnostics prefers local runtime account availability over readyz totals', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-availability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexPath = path.join(dir, 'codex');
  fs.writeFileSync(codexPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codexPath, 0o755);

  const diagnostics = await discoverRuntimeDiagnostics({
    endpoint: 'http://127.0.0.1:9527',
    runtimeDiagnostics: true
  }, {
    fs,
    aiHomeDir: dir,
    env: { PATH: dir },
    projectFallback: false,
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }),
    getToolAccountIds: () => [],
    getToolConfigDir: () => dir,
    getProfileDir: () => dir,
    checkStatus: () => ({ configured: true }),
    loadServerRuntimeAccounts: () => ({
      codex: [{
        id: '2',
        provider: 'codex',
        accessToken: 'sk-test',
        authInvalidUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid',
        lastFailureReason: 'upstream_401',
        schedulableStatus: 'schedulable'
      }],
      claude: [{
        id: '1',
        provider: 'claude',
        accessToken: 'claude-token',
        schedulableStatus: 'schedulable'
      }],
      agy: [],
      opencode: []
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        accounts: {
          codex: 99,
          claude: 99,
          agy: 99,
          opencode: 99
        }
      })
    })
  });

  const codex = diagnostics.find((item) => item.provider === 'codex');
  const claude = diagnostics.find((item) => item.provider === 'claude');
  assert.equal(codex.accounts.source, 'runtime_accounts');
  assert.equal(codex.accounts.total, 1);
  assert.equal(codex.accounts.available, 0);
  assert.equal(codex.accounts.unavailable, 1);
  assert.equal(codex.accounts.reasons[0].reason, 'runtime:auth_invalid:upstream_401');
  assert.equal(claude.accounts.available, 1);
});

test('parseFabricRegistryAgentArgs reads token from token file without exposing it in args', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-agent-token-file-'));
  const tokenFile = path.join(dir, 'node.token');
  fs.writeFileSync(tokenFile, 'file-token\n');

  const options = parseFabricRegistryAgentArgs([
    'https://server.example.com',
    '--token-file',
    tokenFile,
    '--node-id',
    'home-node'
  ], { env: {} });

  assert.equal(options.token, 'file-token');
  assert.equal(options.tokenFile, tokenFile);
  assert.equal(options.endpoint, 'https://server.example.com');
  assert.equal(options.nodeId, 'home-node');
});

test('parseProbeTransport validates transport kind and target', () => {
  assert.deepEqual(parseProbeTransport('relay=tcp://127.0.0.1:8317'), {
    kind: 'relay',
    target: 'tcp://127.0.0.1:8317'
  });
  assert.throws(() => parseProbeTransport('bad=tcp://127.0.0.1:1'), /invalid_fabric_transport/);
  assert.throws(() => parseProbeTransport('relay='), /missing_probe_target/);
});

test('runFabricRegistryAgent reuses heartbeat sender without leaking credentials in events', async () => {
  const calls = [];
  const sleeps = [];
  const events = [];
  const result = await runFabricRegistryAgent([
    'https://server.example.com',
    '--token',
    'secret-token',
    '--node-id',
    'home',
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--probe-transport',
    'relay=tcp://relay.example.com:443',
    '--interval-ms',
    '1000',
    '--count',
    '2'
  ], {
    env: {},
    postFabricRegistryHeartbeat: async (options) => {
      calls.push(options);
      return {
        ok: true,
        endpoint: options.endpoint,
        nodeId: options.nodeId,
        status: options.status,
        relayStatus: options.relayStatus,
        transports: options.transports.length,
        result: {
          registry: {
            counts: {
              nodes: 1,
              relayNodes: 1,
              transports: 1,
              projects: 1,
              runtimes: 4
            }
          }
        }
      };
    },
    runFabricTransportTcpEcho: async (args) => ({
      ok: true,
      args,
      durationMs: 12,
      successes: 1,
      failures: [],
      rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12 }
    }),
    sleep: async (ms) => sleeps.push(ms),
    onEvent: (event) => events.push(event)
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.failures, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, 'secret-token');
  assert.deepEqual(calls[0].transports, [
    {
      kind: 'relay',
      health: 'online',
      lastError: '',
      measurement: {
        status: 'tcp_echo_pass',
        durationMs: 12,
        successes: 1,
        failures: 0,
        sampleCount: 1,
        successRate: 1,
        rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12 }
      }
    }
  ]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(events.length, 2);
  assert.equal(JSON.stringify(events).includes('secret-token'), false);
  assert.equal(events[0].counts.runtimes, 4);
  assert.deepEqual(events[0].probes, [
    {
      kind: 'relay',
      health: 'online',
      lastError: '',
      durationMs: 12,
      status: 'tcp_echo_pass',
      rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12 },
      successes: 1,
      failures: 0,
      sampleCount: 1,
      successRate: 1
    }
  ]);
});

test('runFabricRegistryAgent sends runtime diagnostics when explicitly enabled', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agent-runtime-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexPath = path.join(dir, 'codex');
  fs.writeFileSync(codexPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codexPath, 0o755);

  const calls = [];
  const result = await runFabricRegistryAgent([
    'http://127.0.0.1:9527',
    '--token',
    'secret-token',
    '--node-id',
    'aws-current-node',
    '--runtime-diagnostics',
    '--count',
    '1'
  ], {
    env: { PATH: dir },
    projectFallback: false,
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        accounts: {
          codex: 0,
          claude: 0,
          agy: 0,
          opencode: 0
        }
      })
    }),
    postFabricRegistryHeartbeat: async (options) => {
      calls.push(options);
      return { ok: true, result: { registry: { counts: {} } } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runtimeDiagnostics.length, 4);
  assert.equal(calls[0].runtimeDiagnostics.find((item) => item.provider === 'codex').cli.available, true);
  assert.equal(calls[0].runtimeDiagnostics.find((item) => item.provider === 'claude').cli.available, false);
  assert.equal(JSON.stringify(calls[0].runtimeDiagnostics).includes('secret-token'), false);
});

test('probeAgentTransports dispatches ws and tcp targets to application echo runners', async () => {
  const calls = [];
  const measured = await probeAgentTransports({
    probeTransports: [
      { kind: 'wss', target: 'ws://relay.example.com/echo' },
      { kind: 'relay', target: 'tcp://relay.example.com:9000' }
    ],
    probeTimeoutMs: 4000,
    probeCount: 2,
    probePayloadSize: 16,
    probeMethod: 'HEAD'
  }, {
    runFabricTransportEcho: async (args) => {
      calls.push({ runner: 'ws', args });
      return {
        ok: true,
        durationMs: 20,
        successes: 2,
        failures: [],
        rttMs: { min: 9, p50: 10, p95: 11, max: 11, avg: 10 }
      };
    },
    runFabricTransportTcpEcho: async (args) => {
      calls.push({ runner: 'tcp', args });
      return {
        ok: false,
        durationMs: 30,
        successes: 1,
        failures: [{ id: 'tcp-echo-2', error: 'tcp_echo_response_timeout' }],
        rttMs: { min: 13, p50: 13, p95: 13, max: 13, avg: 13 }
      };
    }
  });

  assert.deepEqual(calls.map((call) => call.runner), ['ws', 'tcp']);
  assert.deepEqual(calls[0].args, [
    'ws://relay.example.com/echo',
    '--timeout-ms',
    '4000',
    '--count',
    '2',
    '--payload-size',
    '16',
    '--json'
  ]);
  assert.deepEqual(calls[1].args, [
    'tcp://relay.example.com:9000',
    '--timeout-ms',
    '4000',
    '--count',
    '2',
    '--payload-size',
    '16',
    '--json'
  ]);
  assert.equal(measured[0].health, 'online');
  assert.equal(measured[0].status, 'ws_echo_pass');
  assert.equal(measured[0].successes, 2);
  assert.equal(measured[0].sampleCount, 2);
  assert.equal(measured[0].successRate, 1);
  assert.equal(measured[1].health, 'degraded');
  assert.equal(measured[1].lastError, 'tcp_echo_response_timeout');
  assert.equal(measured[1].status, 'tcp_echo_fail');
  assert.equal(measured[1].successes, 1);
  assert.equal(measured[1].failures, 1);
  assert.equal(measured[1].sampleCount, 2);
  assert.equal(measured[1].successRate, 0.5);
  assert.equal(measured[1].failureReason, 'tcp_echo_response_timeout');
});

test('runFabricRegistryAgent maps failed probes to degraded heartbeat transport', async () => {
  const calls = [];
  const result = await runFabricRegistryAgent([
    'https://server.example.com',
    '--token',
    'secret-token',
    '--node-id',
    'home',
    '--probe-transport',
    'relay=http://relay.example.com/healthz',
    '--count',
    '1'
  ], {
    env: {},
    postFabricRegistryHeartbeat: async (options) => {
      calls.push(options);
      return { ok: true, result: { registry: { counts: {} } } };
    },
    runFabricTransportProbe: async () => ({
      ok: true,
      probes: [{
        reachable: true,
        networkReachable: true,
        serviceHealthy: false,
        status: 'reachable',
        durationMs: 33,
        http: { status: 503, ok: false }
      }]
    })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].transports, [
    {
      kind: 'relay',
      health: 'degraded',
      lastError: 'http_503',
      measurement: {
        status: 'reachable',
        durationMs: 33,
        failureReason: 'http_503'
      }
    }
  ]);
  assert.deepEqual(result.probes, [
    {
      kind: 'relay',
      health: 'degraded',
      lastError: 'http_503',
      durationMs: 33,
      status: 'reachable',
      failureReason: 'http_503'
    }
  ]);
});

test('mergeTransportHeartbeats lets probe measurements override manual transport health', () => {
  assert.deepEqual(mergeTransportHeartbeats(
    [{ kind: 'relay', health: 'online', lastError: '' }],
    [{
      kind: 'relay',
      health: 'offline',
      lastError: 'ECONNREFUSED',
      durationMs: 30,
      status: 'tcp_echo_fail',
      successes: 0,
      failures: 1,
      sampleCount: 1,
      successRate: 0,
      failureReason: 'ECONNREFUSED',
      rttMs: { p95: 0 }
    }]
  ), [
    {
      kind: 'relay',
      health: 'offline',
      lastError: 'ECONNREFUSED',
      measurement: {
        status: 'tcp_echo_fail',
        durationMs: 30,
        successes: 0,
        failures: 1,
        sampleCount: 1,
        successRate: 0,
        failureReason: 'ECONNREFUSED',
        rttMs: { p95: 0 }
      }
    }
  ]);
});

test('mergeTransportHeartbeats preserves explicit promotion while probe updates liveness', () => {
  assert.deepEqual(mergeTransportHeartbeats(
    [{
      kind: 'webrtc',
      health: 'online',
      lastError: '',
      promotion: {
        remoteRequestReady: true,
        mode: 'direct',
        evidenceRef: 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
        rttP95Ms: 201,
        rpcP95Ms: 200,
        promotedAt: 1782691200000
      }
    }],
    [{
      kind: 'webrtc',
      health: 'online',
      lastError: '',
      durationMs: 30,
      status: 'webrtc_datachannel_pass',
      successes: 20,
      failures: 0,
      sampleCount: 20,
      successRate: 1,
      rttMs: { p95: 201 }
    }]
  ), [
    {
      kind: 'webrtc',
      health: 'online',
      lastError: '',
      measurement: {
        status: 'webrtc_datachannel_pass',
        durationMs: 30,
        successes: 20,
        failures: 0,
        sampleCount: 20,
        successRate: 1,
        rttMs: { p95: 201 }
      },
      promotion: {
        remoteRequestReady: true,
        mode: 'direct',
        evidenceRef: 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
        rttP95Ms: 201,
        rpcP95Ms: 200,
        promotedAt: 1782691200000
      }
    }
  ]);
});

test('formatFabricRegistryAgentEvent summarizes heartbeat counts', () => {
  const line = formatFabricRegistryAgentEvent({
    ok: true,
    attempt: 1,
    nodeId: 'home',
    status: 'online',
    relayStatus: 'online',
    transports: 1,
    probes: [{ kind: 'relay', health: 'online' }],
    counts: {
      nodes: 1,
      relayNodes: 1,
      transports: 1,
      projects: 2,
      runtimes: 4
    }
  });

  assert.match(line, /heartbeat #1/);
  assert.match(line, /node=home/);
  assert.match(line, /probes=relay:online/);
  assert.match(line, /runtimes=4/);
});

test('runFabricCommandRouter routes registry agent JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'registry',
    'agent',
    'https://server.example.com',
    '--token',
    'token',
    '--node-id',
    'home',
    '--count',
    '1',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricRegistryAgent: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      endpoint: 'https://server.example.com',
      nodeId: 'home',
      status: 'online',
      relayStatus: '',
      transports: 0,
      intervalMs: 30000,
      count: 1,
      attempts: 1,
      failures: 0,
      probes: [{ kind: 'relay', health: 'online' }],
      lastResult: { nodeId: 'home' },
      lastError: null
    })
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.nodeId, 'home');
  assert.equal(payload.attempts, 1);
  assert.deepEqual(payload.probes, [{ kind: 'relay', health: 'online' }]);
});
