const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFabricNodeInventory } = require('../lib/server/fabric-node-inventory');

test('fabric node inventory gates provider sessions per node, not by global runtime count', () => {
  const inventory = buildFabricNodeInventory({
    nodes: [
      { id: 'aws-current-node', name: 'AWS Current Node', roles: ['node', 'relay-node'], status: 'online' },
      { id: 'local-mac-remote-node', name: 'Local Mac Remote Node', roles: ['node', 'relay-node'], status: 'online' }
    ],
    relayNodes: [
      { id: 'aws-current-node-relay', nodeId: 'aws-current-node', enabled: true, status: 'online' },
      { id: 'local-mac-remote-node-relay', nodeId: 'local-mac-remote-node', enabled: true, status: 'online' }
    ],
    projects: [
      { id: 'aws-project', nodeId: 'aws-current-node', name: 'aih-fabric-current' },
      { id: 'local-project', nodeId: 'local-mac-remote-node', name: 'ai_home' }
    ],
    runtimes: [
      { id: 'local-codex', nodeId: 'local-mac-remote-node', provider: 'codex', mode: 'tui', status: 'available' },
      { id: 'local-claude', nodeId: 'local-mac-remote-node', provider: 'claude', mode: 'tui', status: 'available' },
      { id: 'local-agy', nodeId: 'local-mac-remote-node', provider: 'agy', mode: 'tui', status: 'available' },
      { id: 'local-opencode', nodeId: 'local-mac-remote-node', provider: 'opencode', mode: 'tui', status: 'available' }
    ],
    transports: [
      {
        id: 'aws-current-node-relay',
        nodeId: 'aws-current-node',
        ownerId: 'aws-current-node-relay',
        kind: 'relay',
        health: 'online',
        measurement: { status: 'ws_echo_pass', sampleCount: 20, successRate: 1 }
      },
      {
        id: 'local-mac-remote-node-relay',
        nodeId: 'local-mac-remote-node',
        ownerId: 'local-mac-remote-node-relay',
        kind: 'relay',
        health: 'online'
      }
    ],
    networkMeasurements: []
  });

  const aws = inventory.find((node) => node.id === 'aws-current-node');
  const local = inventory.find((node) => node.id === 'local-mac-remote-node');
  assert.ok(aws);
  assert.ok(local);

  assert.equal(aws.capabilities.projectHost, true);
  assert.equal(aws.capabilities.relayNode, true);
  assert.equal(aws.capabilities.runtimeHost, false);
  assert.equal(aws.capabilities.measured, true);
  assert.deepEqual(aws.capabilities.runtimeProviders, []);
  assert.deepEqual(
    aws.runtimeGaps.map((gap) => `${gap.provider}:${gap.status}:${gap.blocker}`),
    [
      'codex:missing:missing_provider_runtime:codex',
      'claude:missing:missing_provider_runtime:claude',
      'agy:missing:missing_provider_runtime:agy',
      'opencode:missing:missing_provider_runtime:opencode'
    ]
  );
  assert.deepEqual(local.capabilities.runtimeProviders, ['agy', 'claude', 'codex', 'opencode']);
  assert.deepEqual(local.runtimeGaps, []);

  const awsOpenProject = aws.actions.find((action) => action.id === 'open-project');
  const localOpenProject = local.actions.find((action) => action.id === 'open-project');
  assert.equal(awsOpenProject.eligible, true);
  assert.equal(awsOpenProject.enabled, true);
  assert.deepEqual(awsOpenProject.blockers, []);
  assert.equal(localOpenProject.eligible, true);
  assert.equal(localOpenProject.enabled, true);
  assert.deepEqual(localOpenProject.blockers, []);

  const awsCodex = aws.actions.find((action) => action.id === 'start-session:codex');
  const localCodex = local.actions.find((action) => action.id === 'start-session:codex');
  assert.ok(awsCodex);
  assert.ok(localCodex);
  assert.equal(awsCodex.eligible, false);
  assert.equal(awsCodex.enabled, false);
  assert.equal(awsCodex.blockers.includes('missing_provider_runtime:codex'), true);
  assert.deepEqual(awsCodex.blockers, ['missing_provider_runtime:codex']);
  assert.equal(localCodex.eligible, true);
  assert.equal(localCodex.enabled, true);
  assert.deepEqual(localCodex.blockers, []);
});

test('fabric node inventory treats ssh as bootstrap capability, not runtime readiness', () => {
  const inventory = buildFabricNodeInventory({
    nodes: [
      { id: 'ssh-host', name: 'SSH Host', roles: ['node'], capabilities: ['ssh-bootstrap'], status: 'online' }
    ],
    relayNodes: [],
    projects: [],
    runtimes: [],
    transports: [
      { id: 'ssh-host-ssh', nodeId: 'ssh-host', kind: 'ssh', health: 'online' }
    ],
    networkMeasurements: []
  });
  const host = inventory[0];
  assert.equal(host.capabilities.sshBootstrap, true);
  assert.equal(host.capabilities.runtimeHost, false);
  assert.deepEqual(host.runtimeGaps.map((gap) => gap.provider), ['codex', 'claude', 'agy', 'opencode']);
  assert.equal(host.actions.find((action) => action.id === 'open-project').enabled, false);
  assert.deepEqual(host.actions.find((action) => action.id === 'open-project').blockers, ['missing_project_snapshot']);
  assert.equal(host.actions.find((action) => action.id === 'configure-ssh').enabled, true);
  assert.equal(
    host.actions.find((action) => action.id === 'start-session:codex').blockers.includes('missing_provider_runtime:codex'),
    true
  );
});

test('fabric node inventory blocks registered runtime when all provider accounts are unavailable', () => {
  const inventory = buildFabricNodeInventory({
    nodes: [
      { id: 'aws-current-node', name: 'AWS Current Node', roles: ['node', 'relay-node'], status: 'online' }
    ],
    relayNodes: [
      { id: 'aws-current-node-relay', nodeId: 'aws-current-node', enabled: true, status: 'online' }
    ],
    projects: [
      { id: 'aws-project', nodeId: 'aws-current-node', name: 'aih-fabric-current' }
    ],
    runtimes: [
      { id: 'aws-codex-api', nodeId: 'aws-current-node', provider: 'codex', mode: 'api', status: 'available' }
    ],
    runtimeDiagnostics: [
      {
        id: 'aws-codex-diagnostic',
        nodeId: 'aws-current-node',
        provider: 'codex',
        cli: { command: 'codex', available: true, path: '/app/.runtime-tools/bin/codex' },
        accounts: {
          total: 2,
          schedulable: 0,
          source: 'runtime_accounts',
          reasons: [{ reason: 'runtime:auth_invalid:upstream_401', count: 2, sampleAccountIds: ['1', '2'] }]
        }
      }
    ],
    transports: [
      { id: 'aws-current-node-relay', nodeId: 'aws-current-node', kind: 'relay', health: 'online' }
    ]
  });

  const node = inventory[0];
  assert.equal(node.capabilities.runtimeHost, true);
  assert.deepEqual(node.capabilities.runtimeProviders, ['codex']);
  assert.deepEqual(
    node.runtimeGaps.map((gap) => `${gap.provider}:${gap.status}:${gap.blocker}`),
    [
      'codex:degraded:provider_account_unavailable:codex',
      'claude:missing:missing_provider_runtime:claude',
      'agy:missing:missing_provider_runtime:agy',
      'opencode:missing:missing_provider_runtime:opencode'
    ]
  );
  const codexAction = node.actions.find((action) => action.id === 'start-session:codex');
  assert.equal(codexAction.enabled, false);
  assert.equal(codexAction.eligible, false);
  assert.equal(codexAction.runtimeStatus, 'degraded');
  assert.deepEqual(codexAction.blockers, ['provider_account_unavailable:codex']);
});
