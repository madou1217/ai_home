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
  assert.deepEqual(local.capabilities.runtimeProviders, ['agy', 'claude', 'codex', 'opencode']);

  const awsCodex = aws.actions.find((action) => action.id === 'start-session:codex');
  const localCodex = local.actions.find((action) => action.id === 'start-session:codex');
  assert.ok(awsCodex);
  assert.ok(localCodex);
  assert.equal(awsCodex.eligible, false);
  assert.equal(awsCodex.enabled, false);
  assert.equal(awsCodex.blockers.includes('missing_provider_runtime:codex'), true);
  assert.equal(awsCodex.blockers.includes('m4_remote_session_action_pending'), true);
  assert.equal(localCodex.eligible, true);
  assert.equal(localCodex.enabled, false);
  assert.deepEqual(localCodex.blockers, ['m4_remote_session_action_pending']);
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
  assert.equal(host.actions.find((action) => action.id === 'configure-ssh').enabled, true);
  assert.equal(
    host.actions.find((action) => action.id === 'start-session:codex').blockers.includes('missing_provider_runtime:codex'),
    true
  );
});
