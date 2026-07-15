const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  createRemoteNodeInvite,
  REMOTE_INVITES_KEY,
  listRemoteNodeInvites
} = require('../lib/server/remote/worker-join-invite');
const { joinRemoteNodeWithInvite } = require('../lib/server/remote/node-join');
const { listRemoteNodes } = require('../lib/server/remote/node-registry');
const { listNodeTransports } = require('../lib/server/remote/transport-registry');
const { readRemoteSecret } = require('../lib/server/remote/secret-store');
const { readJsonValue } = require('../lib/server/app-state-store');

test('remote worker join invite stores hashes and joins a node once', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-worker-join-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  const created = createRemoteNodeInvite({
    nodeId: 'office-node',
    name: 'Office Node',
    controlEndpoint: 'https://control.example.com',
    preferredTransports: ['tailscale', 'frp'],
    capabilities: ['status', 'metrics'],
    tags: ['office']
  }, deps);

  assert.equal(created.invite.nodeId, 'office-node');
  assert.match(created.joinUrl, /^https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=/);
  assert.equal(created.invite.codeHash, undefined);
  assert.equal(listRemoteNodeInvites(deps)[0].codeHash, undefined);
  assert.doesNotMatch(JSON.stringify(readJsonValue(fs, aiHomeDir, REMOTE_INVITES_KEY)), new RegExp(created.code));

  const joined = joinRemoteNodeWithInvite({
    code: created.code,
    node: {
      endpoint: 'http://100.64.0.12:9527',
      managementKey: 'node-secret',
      transportKind: 'tailscale'
    }
  }, deps);

  assert.equal(joined.node.id, 'office-node');
  assert.equal(joined.node.transports[0].endpoint, 'http://100.64.0.12:9527');
  assert.equal(joined.node.transports[0].kind, 'tailscale');
  assert.equal(joined.node.transports[0].provider, 'tailscale');
  assert.equal(joined.node.transports[0].trustLevel, 'verified');
  assert.equal(joined.node.transports[0].managedBy, 'worker-join');
  assert.equal(readRemoteSecret('remote-node/office-node', deps).managementKey, 'node-secret');
  assert.equal(listRemoteNodes(deps).length, 1);
  assert.equal(listNodeTransports('office-node', deps).length, 1);

  assert.throws(() => joinRemoteNodeWithInvite({
    code: created.code,
    node: { endpoint: 'http://100.64.0.12:9527' }
  }, deps), /invite_already_consumed/);
});

test('remote worker join invites default to relay for no-public-IP nodes', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-worker-join-default-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  const created = createRemoteNodeInvite({
    nodeId: 'nat-node',
    name: 'NAT Node',
    controlEndpoint: 'https://control.example.com'
  }, deps);

  assert.equal(created.invite.transportKind, 'relay');
  assert.equal(created.invite.provider, 'aih-relay');
  assert.equal(created.invite.routeRole, 'data-plane');
  assert.equal(created.invite.trustLevel, 'managed');
});

test('remote worker join invite can register relay transport without public endpoint', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-worker-join-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  const created = createRemoteNodeInvite({
    nodeId: 'nat-node',
    name: 'NAT Node',
    controlEndpoint: 'https://control.example.com',
    preferredTransports: ['relay']
  }, deps);
  const joined = joinRemoteNodeWithInvite({
    code: created.code,
    node: {
      managementKey: 'node-secret'
    }
  }, deps);

  assert.equal(joined.node.id, 'nat-node');
  assert.equal(joined.node.transports[0].kind, 'relay');
  assert.equal(joined.node.transports[0].endpoint, 'relay://nat-node');
  assert.equal(readRemoteSecret('remote-node/nat-node', deps).managementKey, 'node-secret');
});
