const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  authorizeManagementKey,
  authorizeManagementKeyOrLoopback
} = require('../lib/server/management-key-auth');
const {
  authorizeWebUiRequest
} = require('../lib/server/webui-auth-gate');
const {
  listControlPlaneProfiles,
  saveControlPlaneProfile
} = require('../lib/server/control-plane-profile-store');
const {
  handleWebUiControlPlaneRoutes
} = require('../lib/server/webui-control-plane-routes');
const {
  handleNodeRpcRequest
} = require('../lib/server/node-rpc-router');
const {
  handleFabricRequest
} = require('../lib/server/fabric-router');
const {
  resolveProxyTarget,
  syncRotatedProxyCredential
} = require('../lib/server/webui-server-proxy');
const {
  readJsonValue,
  writeJsonValue
} = require('../lib/server/app-state-store');

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk || '');
    }
  };
}

function parseAuthorizationBearer(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value || '').trim());
  return match && match[1] ? match[1].trim() : '';
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

test('management key guard rejects unconfigured, missing, and wrong credentials', () => {
  assert.deepEqual(
    authorizeManagementKey({ req: { headers: {} }, requiredManagementKey: '' }),
    { ok: false, statusCode: 503, error: 'management_key_not_configured' }
  );
  assert.deepEqual(
    authorizeManagementKey({ req: { headers: {} }, requiredManagementKey: 'server-secret' }),
    { ok: false, statusCode: 401, error: 'unauthorized_management' }
  );
  assert.deepEqual(
    authorizeManagementKey({
      req: { headers: { authorization: 'Bearer wrong-secret' } },
      requiredManagementKey: 'server-secret'
    }),
    { ok: false, statusCode: 401, error: 'unauthorized_management' }
  );
  assert.deepEqual(
    authorizeManagementKey({
      req: { headers: { authorization: 'Bearer server-secrex' } },
      requiredManagementKey: 'server-secret'
    }),
    { ok: false, statusCode: 401, error: 'unauthorized_management' }
  );
});

test('management key guard accepts the canonical bearer credential', () => {
  assert.deepEqual(
    authorizeManagementKey({
      req: { headers: { authorization: 'Bearer server-secret' } },
      requiredManagementKey: 'server-secret'
    }),
    { ok: true, via: 'management_key' }
  );
});

test('unconfigured management access remains local-only and fails closed remotely', () => {
  assert.deepEqual(
    authorizeManagementKeyOrLoopback({
      req: { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} },
      requiredManagementKey: ''
    }),
    { ok: true, via: 'loopback' }
  );
  assert.deepEqual(
    authorizeManagementKeyOrLoopback({
      req: { socket: { remoteAddress: '192.0.2.10' }, headers: {} },
      requiredManagementKey: ''
    }),
    { ok: false, statusCode: 503, error: 'management_key_not_configured' }
  );
});

test('WebUI requires the Management Key for loopback and remote clients', () => {
  const loopbackMissing = authorizeWebUiRequest({
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    url: new URL('http://127.0.0.1:9527/v0/webui/projects'),
    requiredManagementKey: 'server-secret'
  });
  assert.deepEqual(loopbackMissing, {
    ok: false,
    statusCode: 401,
    error: 'webui_unauthorized',
    reason: 'missing_credential'
  });

  const loopbackUnconfigured = authorizeWebUiRequest({
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    url: new URL('http://127.0.0.1:9527/v0/webui/projects'),
    requiredManagementKey: ''
  });
  assert.deepEqual(loopbackUnconfigured, {
    ok: false,
    statusCode: 503,
    error: 'webui_unauthorized',
    reason: 'management_key_not_configured'
  });

  const loopbackAuthorized = authorizeWebUiRequest({
    req: {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { authorization: 'Bearer server-secret' }
    },
    url: new URL('http://127.0.0.1:9527/v0/webui/projects'),
    requiredManagementKey: 'server-secret'
  });
  assert.deepEqual(loopbackAuthorized, { ok: true, via: 'management_key' });

  for (const pathname of [
    '/v0/webui/internal/approval-request',
    '/v0/webui/session-events/provider-hook'
  ]) {
    const internal = authorizeWebUiRequest({
      req: {
        method: 'POST',
        url: pathname,
        socket: { remoteAddress: '127.0.0.1' },
        headers: {}
      },
      url: new URL(`http://127.0.0.1:9527${pathname}`),
      requiredManagementKey: ''
    });
    assert.deepEqual(internal, { ok: true, via: 'internal_loopback' });
  }

  const internalRemote = authorizeWebUiRequest({
    req: {
      method: 'POST',
      socket: { remoteAddress: '192.168.1.20' },
      headers: {}
    },
    url: new URL('http://server/v0/webui/internal/approval-request'),
    requiredManagementKey: 'server-secret'
  });
  assert.equal(internalRemote.ok, false);
  assert.equal(internalRemote.statusCode, 401);

  const internalGet = authorizeWebUiRequest({
    req: {
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {}
    },
    url: new URL('http://127.0.0.1:9527/v0/webui/internal/approval-request'),
    requiredManagementKey: 'server-secret'
  });
  assert.equal(internalGet.ok, false);
  assert.equal(internalGet.statusCode, 401);

  const authorized = authorizeWebUiRequest({
    req: {
      socket: { remoteAddress: '192.0.2.10' },
      headers: { authorization: 'Bearer server-secret' }
    },
    url: new URL('https://server.example.com/v0/webui/projects'),
    requiredManagementKey: 'server-secret'
  });
  assert.deepEqual(authorized, { ok: true, via: 'management_key' });

  const rejected = authorizeWebUiRequest({
    req: {
      socket: { remoteAddress: '192.0.2.10' },
      headers: { authorization: 'Bearer obsolete-client-secret' }
    },
    url: new URL('https://server.example.com/v0/webui/projects'),
    requiredManagementKey: 'server-secret'
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.reason, 'unauthorized_management');

  const queryRejected = authorizeWebUiRequest({
    req: { socket: { remoteAddress: '192.0.2.10' }, headers: {} },
    url: new URL('https://server.example.com/v0/webui/projects?access_token=server-secret'),
    requiredManagementKey: 'server-secret'
  });
  assert.equal(queryRejected.ok, false);
  assert.equal(queryRejected.statusCode, 401);
  assert.equal(queryRejected.reason, 'missing_credential');
});

test('server profile store persists only Management Key and canonical states', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-management-key-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saved = saveControlPlaneProfile({
    id: 'server-aws',
    name: 'AWS',
    endpoint: 'https://aws.example.com',
    state: 'ready',
    managementKey: 'server-secret'
  }, { active: true }, { fs, aiHomeDir });

  assert.equal(saved.profile.state, 'ready');
  assert.equal(saved.profile.managementKey, 'server-secret');
  assert.equal(Object.hasOwn(saved.profile, 'authState'), false);
  assert.equal(Object.hasOwn(saved.profile, 'deviceToken'), false);
  assert.equal(saved.store.version, 2);
  assert.deepEqual(listControlPlaneProfiles({ fs, aiHomeDir }), saved.store);
});

test('WebUI server proxy resolves the remote Management Key from the canonical profile', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-proxy-key-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  saveControlPlaneProfile({
    id: 'server-aws',
    endpoint: 'https://aws.example.com',
    state: 'ready',
    managementKey: 'server-secret'
  }, { active: true }, { fs, aiHomeDir });

  const target = resolveProxyTarget({
    req: {
      headers: { 'x-aih-server-id': 'server-aws' },
      url: '/v0/webui/projects'
    },
    requestHost: '127.0.0.1:9527',
    deps: { fs, aiHomeDir }
  });

  assert.equal(target.profileId, 'server-aws');
  assert.equal(target.endpoint, 'https://aws.example.com');
  assert.equal(target.managementKey, 'server-secret');
  assert.equal(target.profile.id, 'server-aws');
  assert.equal(Object.hasOwn(target, 'deviceToken'), false);

  syncRotatedProxyCredential({
    target,
    body: Buffer.from(JSON.stringify({
      managementKey: 'rotated-server-secret-that-is-long-enough'
    })),
    deps: { fs, aiHomeDir }
  });
  const updated = listControlPlaneProfiles({ fs, aiHomeDir })
    .profiles.find((profile) => profile.id === 'server-aws');
  assert.equal(updated.managementKey, 'rotated-server-secret-that-is-long-enough');
  assert.equal(updated.endpoint, 'https://aws.example.com');
});

test('legacy profile auth fields are not accepted as Management Key fallback', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-breaking-schema-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saved = saveControlPlaneProfile({
    endpoint: 'https://legacy.example.com',
    state: 'paired',
    authState: 'paired',
    deviceToken: 'obsolete-client-secret'
  }, {}, { fs, aiHomeDir });

  assert.equal(saved.profile.state, 'offline');
  assert.equal(saved.profile.managementKey, '');
  assert.equal(Object.hasOwn(saved.profile, 'authState'), false);
  assert.equal(Object.hasOwn(saved.profile, 'deviceToken'), false);
});

test('reading a version 1 profile store rewrites raw storage without legacy credentials', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-v1-rewrite-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  assert.equal(writeJsonValue(fs, aiHomeDir, 'control-plane:profiles', {
    version: 1,
    activeProfileId: 'server-legacy',
    profiles: [{
      id: 'server-legacy',
      endpoint: 'https://legacy.example.com',
      state: 'paired',
      authState: 'paired',
      deviceToken: 'obsolete-client-secret'
    }]
  }), true);

  const migrated = listControlPlaneProfiles({ fs, aiHomeDir });
  const raw = readJsonValue(fs, aiHomeDir, 'control-plane:profiles');

  assert.equal(migrated.version, 2);
  assert.equal(migrated.profiles[0].state, 'offline');
  assert.equal(migrated.profiles[0].managementKey, '');
  assert.equal(raw.version, 2);
  assert.equal(JSON.stringify(raw).includes('obsolete-client-secret'), false);
  assert.equal(Object.hasOwn(raw.profiles[0], 'authState'), false);
  assert.equal(Object.hasOwn(raw.profiles[0], 'deviceToken'), false);
});

test('reading a version 2 profile store physically removes injected legacy credentials', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-profile-v2-cleanup-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  saveControlPlaneProfile({
    id: 'server-current',
    endpoint: 'https://current.example.com',
    state: 'ready',
    managementKey: 'server-secret'
  }, { active: true }, { fs, aiHomeDir });
  const injected = readJsonValue(fs, aiHomeDir, 'control-plane:profiles');
  injected.profiles[0].state = 'paired';
  injected.profiles[0].authState = 'paired';
  injected.profiles[0].deviceToken = 'obsolete-client-secret';
  assert.equal(writeJsonValue(fs, aiHomeDir, 'control-plane:profiles', injected), true);

  const migrated = listControlPlaneProfiles({ fs, aiHomeDir });
  const raw = readJsonValue(fs, aiHomeDir, 'control-plane:profiles');

  assert.equal(migrated.profiles[0].state, 'offline');
  assert.equal(migrated.profiles[0].managementKey, 'server-secret');
  assert.equal(JSON.stringify(raw).includes('obsolete-client-secret'), false);
  assert.equal(Object.hasOwn(raw.profiles[0], 'authState'), false);
  assert.equal(Object.hasOwn(raw.profiles[0], 'deviceToken'), false);
});

test('WebUI no longer exposes client invite or revoke routes', async () => {
  const handled = await handleWebUiControlPlaneRoutes({
    method: 'GET',
    pathname: '/v0/webui/control-plane/devices',
    req: { headers: {} },
    res: createResponse()
  });
  assert.equal(handled, false);
});

test('removed client credential endpoints return not found', async () => {
  const nodeRes = createResponse();
  await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-pair',
    url: new URL('https://server.example.com/v0/node-rpc/device-pair'),
    req: { headers: { authorization: 'Bearer server-secret' } },
    res: nodeRes,
    options: {},
    state: {},
    requiredManagementKey: 'server-secret',
    deps: {
      parseAuthorizationBearer,
      writeJson
    }
  });
  assert.equal(nodeRes.statusCode, 404);
  assert.equal(JSON.parse(nodeRes.body).error, 'node_rpc_not_found');

  const fabricRes = createResponse();
  await handleFabricRequest({
    method: 'POST',
    pathname: '/v0/fabric/device-pair',
    url: new URL('https://server.example.com/v0/fabric/device-pair'),
    req: { headers: { authorization: 'Bearer server-secret' } },
    res: fabricRes,
    options: {},
    state: {},
    requiredManagementKey: 'server-secret',
    deps: {
      parseAuthorizationBearer,
      writeJson,
      readRequestBody: async () => Buffer.alloc(0)
    }
  });
  assert.equal(fabricRes.statusCode, 404);
  assert.equal(JSON.parse(fabricRes.body).error, 'fabric_route_not_found');
});
