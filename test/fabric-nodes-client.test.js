'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRegistryUrl,
  formatReport,
  parseArgs,
  runFabricNodesClient
} = require('../lib/cli/services/fabric/nodes-client');
const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  saveControlPlaneProfile
} = require('../lib/server/control-plane-profile-store');
const { writeJsonValue } = require('../lib/server/app-state-store');

function createAiHome(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-nodes-client-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function saveProfile(aiHomeDir, overrides = {}) {
  return saveControlPlaneProfile({
    id: 'cp-aws',
    name: 'AWS Current',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    connectionMode: 'direct',
    state: 'ready',
    managementKey: 'management-secret',
    ...overrides
  }, { active: true }, { fs, aiHomeDir }).profile;
}

function createRegistryResult() {
  return {
    version: 1,
    nodes: [
      { id: 'aws-current-node', name: 'AWS Current Node', roles: ['node', 'relay-node'], status: 'online' },
      { id: 'local-mac-remote-node', name: 'Local Mac Remote Node', roles: ['node', 'relay-node'], status: 'online' }
    ],
    relayNodes: [
      { id: 'aws-current-node-relay', nodeId: 'aws-current-node', enabled: true, status: 'online' },
      { id: 'local-mac-remote-node-relay', nodeId: 'local-mac-remote-node', enabled: true, status: 'online' }
    ],
    projects: [
      { id: 'aws-project', nodeId: 'aws-current-node', name: 'aih-fabric-current', displayPath: '/home/ubuntu/aih-fabric-current' },
      { id: 'local-project', nodeId: 'local-mac-remote-node', name: 'ai_home', displayPath: '/Users/model/projects/feature/ai_home' }
    ],
    runtimes: [
      { id: 'aws-codex', nodeId: 'aws-current-node', provider: 'codex', mode: 'api', status: 'available' },
      { id: 'aws-claude', nodeId: 'aws-current-node', provider: 'claude', mode: 'api', status: 'available' },
      { id: 'aws-agy', nodeId: 'aws-current-node', provider: 'agy', mode: 'api', status: 'available' },
      { id: 'aws-opencode', nodeId: 'aws-current-node', provider: 'opencode', mode: 'api', status: 'available' },
      { id: 'local-codex', nodeId: 'local-mac-remote-node', provider: 'codex', mode: 'tui', status: 'available' },
      { id: 'local-claude', nodeId: 'local-mac-remote-node', provider: 'claude', mode: 'tui', status: 'available' },
      { id: 'local-agy', nodeId: 'local-mac-remote-node', provider: 'agy', mode: 'tui', status: 'available' },
      { id: 'local-opencode', nodeId: 'local-mac-remote-node', provider: 'opencode', mode: 'tui', status: 'available' }
    ],
    runtimeDiagnostics: [
      {
        id: 'aws-codex-diagnostic',
        nodeId: 'aws-current-node',
        provider: 'codex',
        cli: { available: true, path: '/app/node_modules/.bin/codex' },
        accounts: {
          total: 2,
          schedulable: 0,
          source: 'runtime_accounts',
          reasons: [{ reason: 'runtime:auth_invalid:upstream_401', count: 2, sampleAccountRefs: ['acct_11111111111111111111', 'acct_22222222222222222222'] }]
        }
      },
      {
        id: 'aws-claude-diagnostic',
        nodeId: 'aws-current-node',
        provider: 'claude',
        cli: { available: true, path: '/app/.runtime-tools/bin/claude' },
        accounts: { total: 0, source: 'readyz' }
      },
      {
        id: 'aws-agy-diagnostic',
        nodeId: 'aws-current-node',
        provider: 'agy',
        cli: { available: true, path: '/app/.runtime-tools/bin/agy' },
        accounts: { total: 0, source: 'readyz' }
      },
      {
        id: 'aws-opencode-diagnostic',
        nodeId: 'aws-current-node',
        provider: 'opencode',
        cli: { available: true, path: '/app/.runtime-tools/bin/opencode' },
        accounts: { total: 0, source: 'readyz' }
      }
    ],
    transports: [
      {
        id: 'aws-current-node-relay',
        nodeId: 'aws-current-node',
        kind: 'relay',
        health: 'online',
        measurement: { status: 'ws_echo_pass', sampleCount: 20, successRate: 1, failures: 0, rttMs: { p95: 1, count: 20 } }
      },
      { id: 'local-mac-remote-node-relay', nodeId: 'local-mac-remote-node', kind: 'relay', health: 'online' }
    ],
    networkMeasurements: []
  };
}

test('fabric nodes client parser uses active ready Server profile by default', () => {
  const options = parseArgs(['aws-current-node', '--json'], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.endpoint, '');
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.json, true);
});

test('fabric nodes client reads AWS profile registry and explains runtime gaps', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  const calls = [];

  const report = await runFabricNodesClient({
    aiHomeDir,
    nodeId: 'aws-current-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        authorization: String(init.headers && init.headers.authorization || '')
      });
      if (!init.headers || !init.headers.authorization) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ ok: false, error: 'unauthorized_control_plane_device' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.registry.read',
          result: createRegistryResult()
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.profile.managementKeyConfigured, true);
  assert.equal(report.registry.counts.nodes, 2);
  assert.equal(report.summary.targetNodeId, 'aws-current-node');
  assert.equal(report.summary.targetRuntimeHost, true);
  assert.deepEqual(report.summary.targetRuntimeProviders, ['agy', 'claude', 'codex', 'opencode']);
  assert.deepEqual(
    report.summary.targetRuntimeGaps.map((gap) => `${gap.provider}:${gap.blocker}`),
    [
      'codex:provider_account_unavailable:codex',
      'claude:missing_provider_account:claude',
      'agy:missing_provider_account:agy',
      'opencode:missing_provider_account:opencode'
    ]
  );
  assert.equal(report.targetNode.capabilities.relayNode, true);
  assert.equal(report.targetNode.capabilities.projectHost, true);
  assert.equal(report.targetNode.capabilities.measured, true);
  const codexAction = report.targetNode.actions.find((action) => action.id === 'start-session:codex');
  const codexGap = report.summary.targetRuntimeGaps.find((gap) => gap.provider === 'codex');
  assert.equal(codexAction.eligible, false);
  assert.equal(codexAction.runtimeStatus, 'degraded');
  assert.equal(codexGap.status, 'degraded');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, '');
  assert.equal(calls[1].authorization, 'Bearer management-secret');
  assert.equal(
    calls[0].url,
    buildRegistryUrl('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527')
  );
  assert.equal(JSON.stringify(report).includes('management-secret'), false);
  assert.match(formatReport(report), /runtime_host=yes/);
  assert.match(formatReport(report), /provider_account_unavailable:codex \(cli=yes account_total=2 account_available=0 account_unavailable=2 account_source=runtime_accounts account_reasons=runtime:auth_invalid:upstream_401=2/);
});

test('fabric nodes client enriches AWS node with local SSH workspace without leaking credentials', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  writeJsonValue(fs, aiHomeDir, 'ssh_connections', [
    {
      id: 'conn_aws',
      label: 'AWS Current Japan',
      host: 'ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
      port: 22,
      user: 'ubuntu',
      authType: 'key-file',
      identityFile: '~/.ssh/aws.pem',
      privateKey: 'SECRET_PRIVATE_KEY',
      password: 'SECRET_PASSWORD'
    }
  ]);
  writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', [
    {
      id: 'ws_aws',
      connectionId: 'conn_aws',
      label: 'AIH Fabric Current',
      remoteRoot: '/home/ubuntu/aih-fabric-current/'
    }
  ]);

  const report = await runFabricNodesClient({
    aiHomeDir,
    nodeId: 'aws-current-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (_url, init = {}) => {
      if (!init.headers || !init.headers.authorization) {
        return { ok: false, status: 401, json: async () => ({ ok: false }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, rpc: 'fabric.registry.read', result: createRegistryResult() })
      };
    }
  });

  const configureSsh = report.targetNode.actions.find((action) => action.id === 'configure-ssh');
  assert.equal(report.summary.sshBootstrapNodes, 1);
  assert.equal(report.targetNode.capabilities.sshBootstrap, true);
  assert.equal(configureSsh.enabled, true);
  assert.equal(configureSsh.eligible, true);
  assert.deepEqual(configureSsh.blockers, []);
  assert.deepEqual(report.targetNode.localSshBindings, [
    {
      source: 'local_ssh_workspace',
      connectionId: 'conn_aws',
      connectionLabel: 'AWS Current Japan',
      workspaceId: 'ws_aws',
      workspaceLabel: 'AIH Fabric Current',
      host: 'ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
      port: 22,
      user: 'ubuntu',
      authType: 'key-file',
      target: 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
      remoteRoot: '/home/ubuntu/aih-fabric-current',
      projectId: 'aws-project',
      projectName: 'aih-fabric-current'
    }
  ]);
  assert.match(formatReport(report), /ssh=yes/);
  assert.match(formatReport(report), /ssh_links:/);
  assert.match(formatReport(report), /AWS Current Japan -> AIH Fabric Current/);
  assert.equal(JSON.stringify(report).includes('SECRET_PRIVATE_KEY'), false);
  assert.equal(JSON.stringify(report).includes('SECRET_PASSWORD'), false);
  assert.equal(JSON.stringify(report).includes('~/.ssh/aws.pem'), false);
});

test('fabric nodes client keeps SSH blocked when local workspace does not match node projects', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  writeJsonValue(fs, aiHomeDir, 'ssh_connections', [
    {
      id: 'conn_other',
      label: 'Other Host',
      host: 'other.example.com',
      port: 22,
      user: 'ubuntu',
      authType: 'agent'
    }
  ]);
  writeJsonValue(fs, aiHomeDir, 'ssh_workspaces', [
    {
      id: 'ws_other',
      connectionId: 'conn_other',
      label: 'Other Workspace',
      remoteRoot: '/srv/other'
    }
  ]);

  const report = await runFabricNodesClient({
    aiHomeDir,
    nodeId: 'aws-current-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (_url, init = {}) => {
      if (!init.headers || !init.headers.authorization) {
        return { ok: false, status: 401, json: async () => ({ ok: false }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, rpc: 'fabric.registry.read', result: createRegistryResult() })
      };
    }
  });

  const configureSsh = report.targetNode.actions.find((action) => action.id === 'configure-ssh');
  assert.equal(report.summary.sshBootstrapNodes, 0);
  assert.equal(report.targetNode.capabilities.sshBootstrap, false);
  assert.equal(configureSsh.enabled, false);
  assert.deepEqual(configureSsh.blockers, ['missing_ssh_bootstrap_transport']);
  assert.deepEqual(report.targetNode.localSshBindings, []);
});

test('fabric nodes client fails when requested node is absent', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);

  const report = await runFabricNodesClient({
    aiHomeDir,
    nodeId: 'missing-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (_url, init = {}) => {
      if (!init.headers || !init.headers.authorization) {
        return { ok: false, status: 401, json: async () => ({ ok: false }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, rpc: 'fabric.registry.read', result: createRegistryResult() })
      };
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.blockers.includes('nodeFound'), true);
});

test('fabric command router routes nodes JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'nodes',
    'aws-current-node',
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
    runFabricNodesClientCommand: async (args) => {
      assert.deepEqual(args, ['aws-current-node', '--json']);
      return {
        ok: true,
        json: true,
        profile: {
          id: 'cp-aws',
          endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
          managementKeyConfigured: true
        },
        target: { nodeId: 'aws-current-node' },
        http: { unauthenticatedStatus: 401, authorizedStatus: 200 },
        registry: { counts: { nodes: 2, relayNodes: 2, transports: 2, projects: 2, runtimes: 4 } },
        summary: {
          nodes: 2,
          targetNodeId: 'aws-current-node',
          targetRuntimeHost: false,
          targetRuntimeGaps: [{ provider: 'codex', blocker: 'missing_provider_runtime:codex' }]
        },
        targetNode: {
          id: 'aws-current-node',
          capabilities: { runtimeHost: false }
        },
        nodes: [],
        blockers: []
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.targetNodeId, 'aws-current-node');
  assert.equal(payload.profile.managementKeyConfigured, true);
  assert.equal(JSON.stringify(payload).includes('management-secret'), false);
});
