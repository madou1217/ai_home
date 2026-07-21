const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  runRealVpsRegistryPublish
} = require('../scripts/fabric-real-vps-registry-publish');

test('parseArgs validates real VPS registry publish inputs', () => {
  const parsed = parseArgs([
    '--port',
    '18482',
    '--node-id',
    'vps-152-jp-v4',
    '--name',
    'VPS 152 Japan',
    '--project',
    '.',
    '--bandwidth-kbps',
    '3072',
    '--agent-count',
    '2',
    '--agent-interval-ms',
    '1000'
  ], { AIH_MANAGEMENT_KEY: 'management-secret' });

  assert.equal(parsed.port, 18482);
  assert.equal(parsed.nodeId, 'vps-152-jp-v4');
  assert.equal(parsed.name, 'VPS 152 Japan');
  assert.equal(parsed.project, process.cwd());
  assert.equal(parsed.bandwidthKbps, 3072);
  assert.equal(parsed.agentCount, 2);
  assert.equal(parsed.agentIntervalMs, 1000);
  assert.deepEqual(parsed.agentProbeTransports, []);
  assert.throws(
    () => parseArgs(['--port', '18482'], { AIH_MANAGEMENT_KEY: 'management-secret' }),
    /--node-id is required/
  );
});

test('runRealVpsRegistryPublish prints only sanitized registry evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-real-vps-registry-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const spawnCalls = [];
  const fetchCalls = [];
  const closedProbeServers = [];
  const report = await runRealVpsRegistryPublish({
    port: 18482,
    nodeId: 'vps-152-jp-v4',
    name: 'VPS 152 Japan',
    project: '/remote/app',
    bandwidthKbps: 3072,
    managementKey: 'management-secret'
  }, {
    aiHomeDir: root,
    execPath: '/usr/bin/node',
    cliPath: '/repo/bin/ai-home.js',
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (args.includes('heartbeat')) {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            ok: true,
            nodeId: 'vps-152-jp-v4',
            status: 'online',
            relayStatus: 'online',
            transports: 1,
            result: {
              registry: {
                counts: { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 }
              }
            }
          }),
          stderr: ''
        };
      }
      if (args.includes('agent')) {
        const probeIndex = args.indexOf('--probe-transport');
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            ok: true,
            nodeId: 'vps-152-jp-v4',
            attempts: 2,
            failures: 0,
            intervalMs: 1000,
            count: 2,
            probes: [{
              kind: 'relay',
              health: 'online',
              durationMs: 3,
              status: 'tcp_echo_pass',
              successes: 1,
              failures: 0
            }],
            receivedProbe: args[probeIndex + 1],
            lastResult: {
              result: {
                registry: {
                  counts: { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 }
                }
              }
            }
          }),
          stderr: ''
        };
      }
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ok: true,
          nodeId: 'vps-152-jp-v4',
          roles: ['node', 'relay-node'],
          projects: 1,
          runtimes: 4,
          transports: 1,
          fromServer: {
            endpoint: 'http://127.0.0.1:18482',
            accounts: 15,
            providers: ['agy', 'claude', 'codex', 'gemini']
          }
        }),
        stderr: ''
      };
    },
    runCommandAsync: async (command, args, options) => {
      spawnCalls.push({ command, args, options });
      assert.equal(args.includes('agent'), true);
      const probeIndex = args.indexOf('--probe-transport');
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ok: true,
          nodeId: 'vps-152-jp-v4',
          attempts: 2,
          failures: 0,
          intervalMs: 1000,
          count: 2,
          probes: [{
            kind: 'relay',
            health: 'online',
            durationMs: 3,
            status: 'tcp_echo_pass',
            successes: 1,
            failures: 0
          }],
          receivedProbe: args[probeIndex + 1],
          lastResult: {
            result: {
              registry: {
                counts: { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 }
              }
            }
          }
        }),
        stderr: ''
      };
    },
    startTcpEchoServer: async () => ({
      ok: true,
      protocol: 'tcp',
      host: '127.0.0.1',
      port: 29001,
      url: 'tcp://127.0.0.1:29001',
      server: {}
    }),
    closeTcpEchoServer: async (server) => closedProbeServers.push(server.port),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.endsWith('/v0/fabric/registry')) {
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              counts: { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 },
              nodes: [{ id: 'vps-152-jp-v4' }],
              relayNodes: [{ id: 'vps-152-jp-v4-relay' }],
              runtimes: [
                { provider: 'codex', mode: 'api', status: 'available' },
                { provider: 'gemini', mode: 'api', status: 'available' }
              ],
              transports: [{ kind: 'relay', health: 'unknown' }]
            }
          })
        };
      }
      return {
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            nodes: [{ id: 'vps-152-jp-v4' }]
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.managementAuth, 'verified');
  assert.deepEqual(report.registryCounts, { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 });
  assert.deepEqual(report.publish.fromServer.providers, ['agy', 'claude', 'codex', 'gemini']);
  assert.equal(report.heartbeat.ok, true);
  assert.deepEqual(report.heartbeat.counts, { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 });
  assert.equal(report.agent.ok, true);
  assert.equal(report.agent.attempts, 2);
  assert.deepEqual(report.agent.lastCounts, { nodes: 1, relayNodes: 1, projects: 1, runtimes: 4, transports: 1 });
  assert.deepEqual(report.agent.probes, [{
    kind: 'relay',
    health: 'online',
    durationMs: 3,
    status: 'tcp_echo_pass',
    successes: 1,
    failures: 0
  }]);
  assert.deepEqual(report.agent.probeServer, {
    protocol: 'tcp',
    host: '127.0.0.1',
    port: 29001,
    kind: 'tcp-echo'
  });
  assert.equal(report.token, undefined);
  assert.equal(JSON.stringify(report).includes('management-secret'), false);
  assert.equal(String(JSON.stringify(report)).includes('Bearer'), false);
  assert.equal(spawnCalls.length, 3);
  assert.equal(spawnCalls[0].options.env.AIH_MANAGEMENT_KEY, 'management-secret');
  assert.equal(spawnCalls[0].args.includes('--from-server'), true);
  assert.equal(spawnCalls[1].args.includes('heartbeat'), true);
  assert.equal(spawnCalls[1].options.env.AIH_MANAGEMENT_KEY, spawnCalls[0].options.env.AIH_MANAGEMENT_KEY);
  assert.equal(spawnCalls[2].args.includes('agent'), true);
  assert.equal(spawnCalls[2].args.includes('--count'), true);
  assert.equal(spawnCalls[2].args.includes('--probe-transport'), true);
  assert.equal(spawnCalls[2].args.includes('relay=tcp://127.0.0.1:29001'), true);
  assert.equal(spawnCalls[2].options.env.AIH_MANAGEMENT_KEY, spawnCalls[0].options.env.AIH_MANAGEMENT_KEY);
  assert.deepEqual(closedProbeServers, [29001]);
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].options.headers.authorization, /^Bearer /);
});
