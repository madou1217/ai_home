'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERVER_IDENTITY_KEY,
  loadOrCreateServerIdentity,
  normalizeServerId
} = require('../lib/server/server-identity');
const { buildFabricDescriptor } = require('../lib/server/fabric-descriptor');

function createIdentityStore() {
  const values = new Map();
  return {
    values,
    readJsonValue(_fs, _aiHomeDir, key) {
      return values.get(key) || null;
    },
    writeJsonValue(_fs, _aiHomeDir, key, value) {
      values.set(key, value);
      return true;
    }
  };
}

test('server identity is persisted once and remains stable across restarts', () => {
  const store = createIdentityStore();
  let generated = 0;
  const deps = {
    ...store,
    hostname: () => 'model-mac.local',
    randomUUID: () => `00000000-0000-4000-8000-${String(++generated).padStart(12, '0')}`
  };

  const first = loadOrCreateServerIdentity({ fs: {}, aiHomeDir: '/tmp/aih' }, deps);
  const second = loadOrCreateServerIdentity({ fs: {}, aiHomeDir: '/tmp/aih' }, deps);

  assert.equal(first.id, 'server-00000000-0000-4000-8000-000000000001');
  assert.equal(first.name, 'model-mac');
  assert.deepEqual(second, first);
  assert.equal(generated, 1);
  assert.equal(JSON.stringify(store.values).includes('management'), false);
});

test('server identity uses the shared 64-character contract and rejects oversized stored identity', () => {
  const maxLengthId = `server-${'a'.repeat(57)}`;
  const oversizedId = `${maxLengthId}b`;
  assert.equal(maxLengthId.length, 64);
  assert.equal(normalizeServerId(maxLengthId), maxLengthId);
  assert.equal(normalizeServerId(oversizedId), '');

  const store = createIdentityStore();
  store.values.set(SERVER_IDENTITY_KEY, { id: oversizedId, name: 'Legacy Server' });
  assert.throws(() => loadOrCreateServerIdentity({ fs: {}, aiHomeDir: '/tmp/aih' }, {
    ...store,
    hostname: () => 'new-host',
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  }), { code: 'invalid_stored_server_identity' });
});

test('server identity feeds the Fabric descriptor', () => {
  const descriptor = buildFabricDescriptor({
    options: { host: '127.0.0.1', port: 9527 },
    state: { serverIdentity: { id: 'server-stable-home', name: 'Home' } }
  });
  assert.equal(descriptor.server.id, 'server-stable-home');
  assert.equal(descriptor.server.name, 'Home');
});
