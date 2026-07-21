'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  AIH_MDNS_SERVICE,
  buildMdnsQuery,
  decodeMdnsPacket
} = require('../lib/server/mdns-packet');
const {
  SERVER_IDENTITY_KEY,
  loadOrCreateServerIdentity,
  normalizeServerId
} = require('../lib/server/server-identity');
const {
  createServerMdnsAdvertiser,
  startServerMdnsDiscovery
} = require('../lib/server/server-mdns-advertiser');
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

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.memberships = [];
  socket.bindCalls = [];
  socket.closed = false;
  socket.bind = (port, address, callback) => {
    socket.bindCalls.push({ port, address });
    callback();
  };
  socket.addMembership = (address) => socket.memberships.push(address);
  socket.setMulticastTTL = () => {};
  socket.setMulticastLoopback = () => {};
  socket.send = (packet, port, address, callback) => {
    socket.sent.push({ packet: Buffer.from(packet), port, address });
    if (callback) callback();
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit('close');
  };
  return socket;
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

test('mDNS advertiser publishes only non-secret Server route metadata', async (t) => {
  const socket = createFakeSocket();
  const intervals = [];
  const advertiser = createServerMdnsAdvertiser({
    serverId: 'server-home',
    name: 'Home Server',
    port: 9527,
    capabilities: ['client-api', 'stream', 'blob'],
    managementKey: 'must-never-be-advertised'
  }, {
    createSocket: () => socket,
    networkInterfaces: () => ({
      en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }]
    }),
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return { unref() {} };
    },
    clearInterval: () => {},
    logWarn: () => {}
  });
  t.after(() => advertiser.stop());

  const started = await advertiser.start();
  assert.equal(started.ok, true);
  assert.deepEqual(socket.bindCalls, [{ port: 5353, address: '0.0.0.0' }]);
  assert.deepEqual(socket.memberships, ['224.0.0.251']);
  assert.equal(intervals.length, 1);

  const announcement = decodeMdnsPacket(socket.sent[0].packet);
  const txt = announcement.answers
    .filter((record) => record.type === 'TXT')
    .flatMap((record) => record.data);
  assert.ok(txt.includes('id=server-home'));
  assert.ok(txt.includes('name=Home Server'));
  assert.ok(txt.includes('capabilities=client-api,stream,blob'));
  assert.equal(socket.sent[0].port, 5353);
  assert.equal(socket.sent[0].address, '224.0.0.251');
  assert.equal(socket.sent[0].packet.includes(Buffer.from('must-never-be-advertised')), false);
});

test('mDNS advertiser answers discovery query directly to an ephemeral client', async (t) => {
  const socket = createFakeSocket();
  const advertiser = createServerMdnsAdvertiser({
    serverId: 'server-lab',
    name: 'Lab',
    port: 19527,
    capabilities: ['client-api']
  }, {
    createSocket: () => socket,
    networkInterfaces: () => ({}),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    logWarn: () => {}
  });
  t.after(() => advertiser.stop());
  await advertiser.start();
  socket.sent.length = 0;

  socket.emit('message', buildMdnsQuery(AIH_MDNS_SERVICE), {
    address: '192.168.1.88',
    port: 41234
  });

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].address, '192.168.1.88');
  assert.equal(socket.sent[0].port, 41234);
  const response = decodeMdnsPacket(socket.sent[0].packet);
  assert.equal(response.answers.some((record) => record.type === 'SRV' && record.data.port === 19527), true);
});

test('mDNS advertiser is best effort when multicast bind fails', async () => {
  const socket = createFakeSocket();
  socket.bind = () => socket.emit('error', new Error('EADDRINUSE'));
  const warnings = [];
  const advertiser = createServerMdnsAdvertiser({
    serverId: 'server-home',
    name: 'Home',
    port: 9527
  }, {
    createSocket: () => socket,
    networkInterfaces: () => ({}),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    logWarn: (message) => warnings.push(message)
  });

  const result = await advertiser.start();

  assert.deepEqual(result, { ok: false, reason: 'mdns_socket_error' });
  assert.equal(warnings.length, 1);
});

test('server discovery lifecycle shares one stable identity with descriptors and stops cleanly', async () => {
  const calls = [];
  let stopped = 0;
  const runtime = await startServerMdnsDiscovery({
    fs: {},
    aiHomeDir: '/tmp/aih',
    port: 9527
  }, {
    loadOrCreateServerIdentity: () => ({ id: 'server-stable-home', name: 'Home' }),
    createServerMdnsAdvertiser: (options) => {
      calls.push(options);
      return {
        start: async () => ({ ok: true }),
        stop: () => { stopped += 1; }
      };
    },
    logWarn: () => {}
  });

  assert.equal(runtime.identity.id, 'server-stable-home');
  assert.deepEqual(calls, [{
    serverId: 'server-stable-home',
    name: 'Home',
    port: 9527,
    capabilities: ['client-api', 'stream', 'blob']
  }]);
  const descriptor = buildFabricDescriptor({
    options: { host: '127.0.0.1', port: 9527 },
    state: { serverIdentity: runtime.identity }
  });
  assert.equal(descriptor.server.id, 'server-stable-home');
  assert.equal(descriptor.server.name, 'Home');

  runtime.stop();
  assert.equal(stopped, 1);
});
