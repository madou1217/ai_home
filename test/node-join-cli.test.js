const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNodeJoinPayload,
  parseInviteUrl,
  runNodeJoin
} = require('../lib/cli/services/node/join');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');

test('parseInviteUrl normalizes legacy invite path to node rpc join endpoint', () => {
  const url = parseInviteUrl('https://control.example.com/invite/abc%20123');
  assert.equal(url.toString(), 'https://control.example.com/v0/node-rpc/join?code=abc+123');
});

test('buildNodeJoinPayload derives node id and display name from local machine', () => {
  const payload = buildNodeJoinPayload({
    invite: 'https://control.example.com/v0/node-rpc/join?code=abc'
  }, {
    hostname: () => 'Dev MacBook Pro',
    platform: 'darwin',
    arch: 'arm64',
    aiHomeDir: '/tmp/aih-dev',
    readServerConfig: () => ({ managementKey: 'node-secret' })
  });

  assert.equal(payload.requestBody.node.name, 'Dev MacBook Pro');
  assert.match(payload.requestBody.node.id, /^dev-macbook-pro-[a-f0-9]{8}$/);
  assert.equal(payload.requestBody.node.transportKind, 'relay');
  assert.equal(payload.requestBody.node.managementKey, 'node-secret');
});

test('runNodeJoin posts local node payload to invite join url', async () => {
  let observed = null;
  const result = await runNodeJoin([
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--endpoint',
    'http://100.64.0.20:9527',
    '--transport',
    'tailscale',
    '--name',
    'Lab Node',
    '--id',
    'lab-node'
  ], {
    hostname: () => 'fallback-host',
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'node-secret'
    }),
    fetchImpl: async (url, options) => {
      observed = {
        url,
        options,
        body: JSON.parse(options.body)
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          node: { id: 'lab-node', name: 'Lab Node' },
          invite: { id: 'invite-1' }
        })
      };
    }
  });

  assert.equal(observed.url, 'https://control.example.com/v0/node-rpc/join?code=abc');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.headers['content-type'], 'application/json');
  assert.deepEqual(observed.body, {
    node: {
      endpoint: 'http://100.64.0.20:9527',
      transportKind: 'tailscale',
      name: 'Lab Node',
      id: 'lab-node',
      managementKey: 'node-secret'
    }
  });
  assert.equal(result.node.id, 'lab-node');
  assert.equal(result.endpoint, 'http://100.64.0.20:9527');
  assert.equal(result.transportKind, 'tailscale');
});

test('runNodeJoin requires invite argument before sending request', async () => {
  let called = false;
  await assert.rejects(
    runNodeJoin([], {
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
    }),
    { code: 'missing_invite' }
  );
  assert.equal(called, false);
});

test('runNodeJoin can join through relay without advertising a public endpoint', async () => {
  let observedBody = null;
  const result = await runNodeJoin([
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--name',
    'NAT Node',
    '--id',
    'nat-node'
  ], {
    hostname: () => 'fallback-host',
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'node-secret'
    }),
    fetchImpl: async (_url, options) => {
      observedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          node: { id: 'nat-node', name: 'NAT Node' },
          invite: { id: 'invite-1' }
        })
      };
    }
  });

  assert.equal(observedBody.node.transportKind, 'relay');
  assert.equal(Object.prototype.hasOwnProperty.call(observedBody.node, 'endpoint'), false);
  assert.equal(observedBody.node.managementKey, 'node-secret');
  assert.equal(result.endpoint, '');
  assert.equal(result.transportKind, 'relay');
});

test('runNodeJoin advertises overlay address when server listens on wildcard host', async () => {
  let observedBody = null;
  await runNodeJoin([
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--transport',
    'tailscale'
  ], {
    hostname: () => 'worker-host',
    networkInterfaces: () => ({
      en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
      tailscale0: [{ family: 'IPv4', address: '100.88.1.20', internal: false }]
    }),
    readServerConfig: () => ({
      host: '0.0.0.0',
      port: 9527,
      managementKey: 'node-secret'
    }),
    fetchImpl: async (_url, options) => {
      observedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          node: { id: 'worker-host', name: 'worker-host' },
          invite: { id: 'invite-1' }
        })
      };
    }
  });

  assert.equal(observedBody.node.endpoint, 'http://100.88.1.20:9527');
});

test('runNodeCommandRouter prints join result without leaking management key', async () => {
  const writes = [];
  const errors = [];
  const exits = [];
  let observedBody = null;

  await runNodeCommandRouter([
    'node',
    'join',
    'https://control.example.com/v0/node-rpc/join?code=abc',
    '--transport',
    'tailscale',
    '--endpoint',
    'http://100.64.0.20:9527'
  ], {
    hostname: () => 'lab-host',
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'node-secret'
    }),
    fetchImpl: async (_url, options) => {
      observedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          node: { id: 'lab-host', name: 'Lab Host' },
          invite: { id: 'invite-1' }
        })
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  assert.equal(observedBody.node.managementKey, 'node-secret');
  assert.equal(writes.join('\n').includes('node-secret'), false);
  assert.equal(errors.join('\n').includes('node-secret'), false);
  assert.deepEqual(exits, [0]);
});
