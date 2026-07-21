'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authorizeBrokerControl,
  handleFabricBrokerProxyRequest
} = require('../lib/server/fabric-broker-router');
const {
  createFabricBrokerSessionRegistry
} = require('../lib/server/fabric-broker-session-registry');
const {
  resolveBrokerServerDescriptor
} = require('../lib/cli/services/fabric/broker-connect');

function createRequest(pathname, managementKey = '') {
  return {
    url: pathname,
    headers: {
      host: 'aws.example.com',
      authorization: managementKey ? `Bearer ${managementKey}` : ''
    }
  };
}

function createJsonContext(pathname, managementKey, registry) {
  const writes = [];
  return {
    writes,
    context: {
      method: 'GET',
      pathname,
      url: new URL(pathname, 'https://aws.example.com'),
      req: createRequest(pathname, managementKey),
      res: {},
      requiredManagementKey: 'aws-management-key',
      deps: {
        requiredManagementKey: 'aws-management-key',
        fabricBrokerSessionRegistry: registry,
        parseAuthorizationBearer(value) {
          return String(value || '').replace(/^Bearer\s+/i, '');
        },
        writeJson(_res, statusCode, payload) {
          writes.push({ statusCode, payload });
        }
      }
    }
  };
}

test('broker control authenticates only with the AWS Management Key', () => {
  const legacyRequest = createRequest(
    '/v0/fabric/broker/control?serverId=local-home',
    'legacy-broker-token'
  );
  const deps = {
    requiredManagementKey: 'aws-management-key',
    brokerToken: 'legacy-broker-token',
    env: { AIH_FABRIC_BROKER_TOKEN: 'legacy-broker-token' }
  };

  assert.deepEqual(authorizeBrokerControl(legacyRequest, deps), {
    ok: false,
    statusCode: 401,
    error: 'unauthorized_management'
  });
  assert.deepEqual(authorizeBrokerControl(
    createRequest('/v0/fabric/broker/control?serverId=local-home', 'aws-management-key'),
    deps
  ), {
    ok: true,
    serverId: 'local-home'
  });
});

test('broker registry exposes a secret-free connected Server descriptor', () => {
  const registry = createFabricBrokerSessionRegistry({
    nowMs: () => 1234,
    createSessionId: () => 'session-1'
  });
  registry.registerBrokerSession({
    serverId: 'local-home',
    socket: { readyState: 1 },
    remoteAddress: '10.0.0.8',
    descriptor: {
      serverId: 'spoofed-id',
      name: 'Home Mac',
      managementKey: 'must-not-leak',
      capabilities: {
        clientApi: true,
        streams: ['sse', 'blob'],
        token: 'must-not-leak'
      },
      routes: [{
        kind: 'lan',
        endpoint: 'http://192.168.1.8:9527',
        secretKey: 'must-not-leak'
      }]
    }
  });

  assert.deepEqual(registry.listBrokerServers(), [{
    stableServerId: 'local-home',
    name: 'Home Mac',
    capabilities: {
      clientApi: true,
      streams: ['sse', 'blob']
    },
    routes: [{
      kind: 'lan',
      endpoint: 'http://192.168.1.8:9527'
    }],
    online: true,
    connectedAt: 1234,
    lastSeenAt: 1234
  }]);
  assert.equal(JSON.stringify(registry.listBrokerServers()).includes('must-not-leak'), false);
});

test('connected Server discovery requires Management Key and adds the current AWS relay route', async () => {
  const registry = createFabricBrokerSessionRegistry({
    nowMs: () => 1234,
    createSessionId: () => 'session-1'
  });
  registry.registerBrokerSession({
    serverId: 'local-home',
    socket: { readyState: 1 },
    descriptor: {
      name: 'Home Mac',
      capabilities: { clientApi: true },
      routes: []
    }
  });

  const denied = createJsonContext('/v0/fabric/broker/servers', 'wrong-key', registry);
  assert.equal(await handleFabricBrokerProxyRequest(denied.context), true);
  assert.deepEqual(denied.writes, [{
    statusCode: 401,
    payload: { ok: false, error: 'unauthorized_management' }
  }]);

  const allowed = createJsonContext('/v0/fabric/broker/servers', 'aws-management-key', registry);
  assert.equal(await handleFabricBrokerProxyRequest(allowed.context), true);
  assert.deepEqual(allowed.writes, [{
    statusCode: 200,
    payload: {
      ok: true,
      rpc: 'fabric.broker.servers.list',
      result: {
        servers: [{
          stableServerId: 'local-home',
          name: 'Home Mac',
          capabilities: { clientApi: true },
          routes: [{
            kind: 'relay',
            path: '/v0/fabric/broker/servers/local-home/proxy'
          }],
          online: true,
          connectedAt: 1234,
          lastSeenAt: 1234
        }]
      }
    }
  }]);
});

test('broker connector derives the registration descriptor from the Local Server descriptor', async () => {
  const descriptor = await resolveBrokerServerDescriptor({
    serverId: 'stable-local-id',
    localUrl: 'http://127.0.0.1:9527'
  }, {
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9527/v0/fabric/descriptor');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            service: 'aih-fabric',
            server: { id: 'unstable-host-derived-id', name: 'Home Mac' },
            capabilities: { client: ['server-profile'], streams: ['sse'] },
            auth: { managementKey: 'must-not-leak' }
          }
        })
      };
    }
  });

  assert.deepEqual(descriptor, {
    stableServerId: 'stable-local-id',
    name: 'Home Mac',
    capabilities: { client: ['server-profile'], streams: ['sse'] },
    routes: []
  });
  assert.equal(JSON.stringify(descriptor).includes('must-not-leak'), false);
});
