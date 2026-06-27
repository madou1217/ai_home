const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleNodeRpcRequest } = require('../lib/server/node-rpc-router');
const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const {
  findControlPlaneDeviceByToken,
  getControlPlaneDevicesPath,
  getControlPlaneDeviceSecretsPath
} = require('../lib/server/control-plane-device-pairing');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createWebDeps(aiHomeDir, body = null, overrides = {}) {
  return {
    fs,
    aiHomeDir,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => body,
    accountStateIndex: {},
    getToolAccountIds() { return []; },
    getToolConfigDir() { return ''; },
    getProfileDir() { return ''; },
    loadServerRuntimeAccounts() { return {}; },
    applyReloadState() {},
    checkStatus() { return {}; },
    ...overrides
  };
}

function createNodeRpcDeps(aiHomeDir, body = null) {
  return {
    fs,
    aiHomeDir,
    parseAuthorizationBearer(value) {
      const text = String(value || '').trim();
      return text.toLowerCase().startsWith('bearer ') ? text.slice(7).trim() : '';
    },
    readRequestBody: async () => body || Buffer.alloc(0),
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    buildManagementStatusPayload() {
      return {};
    },
    accountStateIndex: {}
  };
}

async function createDeviceInvite(aiHomeDir, input = {}) {
  const body = Buffer.from(JSON.stringify({
    name: 'Phone Pair',
    scopes: ['control-plane:read', 'nodes:read'],
    expiresInMs: 600000,
    ...input
  }), 'utf8');
  const res = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/control-plane/devices/invites',
    url: new URL('https://control.example.com/v0/webui/control-plane/devices/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res,
    options: {},
    state: {},
    deps: createWebDeps(aiHomeDir, body)
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

test('control plane device pairing creates invite without exposing stored code hashes', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-pairing-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const created = await createDeviceInvite(aiHomeDir);
  assert.equal(created.ok, true);
  assert.ok(created.code);
  assert.match(created.pairUrl, /^https:\/\/control\.example\.com\/v0\/fabric\/device-pair\?code=/);
  assert.match(created.webPairUrl, /^https:\/\/control\.example\.com\/ui\/server-setup\?pair=/);
  assert.equal(new URL(created.webPairUrl).searchParams.get('pair'), created.pairUrl);
  assert.equal(created.invite.codeHash, undefined);

  const devicesText = fs.readFileSync(getControlPlaneDevicesPath(aiHomeDir), 'utf8');
  const secretsText = fs.readFileSync(getControlPlaneDeviceSecretsPath(aiHomeDir), 'utf8');
  assert.doesNotMatch(devicesText, new RegExp(created.code));
  assert.doesNotMatch(secretsText, new RegExp(created.code));

  const listRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/control-plane/devices/invites',
    url: new URL('https://control.example.com/v0/webui/control-plane/devices/invites'),
    req: { headers: {} },
    res: listRes,
    options: {},
    state: {},
    deps: createWebDeps(aiHomeDir)
  });
  assert.equal(listRes.statusCode, 200);
  assert.doesNotMatch(listRes.body, /codeHash/);
  assert.doesNotMatch(listRes.body, new RegExp(created.code));
});

test('control plane device pairing warns when control endpoint is loopback', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-pairing-loopback-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const created = await createDeviceInvite(aiHomeDir, {
    controlEndpoint: 'http://127.0.0.1:9527'
  });

  assert.equal(created.ok, true);
  assert.equal(created.warnings.some((warning) => warning.includes('手机或其他设备会把它当成自己本机')), true);
  assert.match(created.pairUrl, /^http:\/\/127\.0\.0\.1:9527\/v0\/fabric\/device-pair\?code=/);
  assert.match(created.webPairUrl, /^http:\/\/127\.0\.0\.1:9527\/ui\/server-setup\?pair=/);
});

test('webui control plane endpoints include lan hints for mobile pairing', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-endpoints-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const res = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/control-plane/endpoints',
    url: new URL('http://127.0.0.1:9527/v0/webui/control-plane/endpoints'),
    req: {
      headers: {
        host: '127.0.0.1:9527'
      }
    },
    res,
    options: {
      host: '0.0.0.0',
      port: 9527
    },
    state: {},
    deps: createWebDeps(aiHomeDir, null, {
      networkInterfaces: () => ({
        lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
        en0: [{ family: 'IPv4', address: '192.168.3.22', internal: false }],
        utun9: [{ family: 'IPv4', address: '198.18.0.1', internal: false }]
      })
    })
  });

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.deepEqual(
    payload.endpoints.map((endpoint) => endpoint.endpoint),
    ['http://127.0.0.1:9527', 'http://192.168.3.22:9527']
  );
  assert.equal(payload.endpoints[0].source, 'request');
  assert.equal(payload.endpoints[0].recommended, false);
  assert.equal(payload.endpoints[1].source, 'lan');
  assert.equal(payload.endpoints[1].recommended, true);
  assert.match(payload.warnings.join('\n'), /localhost/);
});

test('webui control plane lan hints are not recommended when server is loopback only', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-loopback-endpoints-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const res = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/control-plane/endpoints',
    url: new URL('http://127.0.0.1:9527/v0/webui/control-plane/endpoints'),
    req: {
      headers: {
        host: '127.0.0.1:9527'
      }
    },
    res,
    options: {
      host: '127.0.0.1',
      port: 9527
    },
    state: {},
    deps: createWebDeps(aiHomeDir, null, {
      networkInterfaces: () => ({
        en0: [{ family: 'IPv4', address: '192.168.3.22', internal: false }]
      })
    })
  });

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  const lanHint = payload.endpoints.find((endpoint) => endpoint.source === 'lan');
  assert.equal(lanHint.endpoint, 'http://192.168.3.22:9527');
  assert.equal(lanHint.recommended, false);
  assert.match(payload.warnings.join('\n'), /只监听本机地址/);
});

test('node rpc device pair consumes invite once, returns token once, and supports revoke', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-consume-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const created = await createDeviceInvite(aiHomeDir);
  const pairBody = Buffer.from(JSON.stringify({
    device: {
      id: 'device-ios-1011121314151617',
      name: 'iPhone',
      platform: 'ios',
      publicKey: 'phone-public-key'
    }
  }), 'utf8');
  const pairRes = createResCapture();
  const paired = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-pair',
    url: new URL(`https://control.example.com/v0/node-rpc/device-pair?code=${encodeURIComponent(created.code)}`),
    req: { headers: {} },
    res: pairRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createNodeRpcDeps(aiHomeDir, pairBody)
  });

  assert.equal(paired, true);
  assert.equal(pairRes.statusCode, 200);
  assert.equal(pairRes.headers['access-control-allow-origin'], '*');
  const pairPayload = JSON.parse(pairRes.body);
  assert.equal(pairPayload.ok, true);
  assert.equal(pairPayload.rpc, 'control_plane.device.pair');
  assert.equal(pairPayload.device.id, 'device-ios-1011121314151617');
  assert.equal(pairPayload.device.name, 'iPhone');
  assert.equal(pairPayload.device.platform, 'ios');
  assert.match(pairPayload.device.publicKeyFingerprint, /^sha256:/);
  assert.ok(pairPayload.token);

  const devicesText = fs.readFileSync(getControlPlaneDevicesPath(aiHomeDir), 'utf8');
  const secretsText = fs.readFileSync(getControlPlaneDeviceSecretsPath(aiHomeDir), 'utf8');
  assert.doesNotMatch(devicesText, new RegExp(pairPayload.token));
  assert.doesNotMatch(secretsText, new RegExp(pairPayload.token));
  assert.equal(findControlPlaneDeviceByToken(pairPayload.token, { fs, aiHomeDir }).id, pairPayload.device.id);

  const secondPairRes = createResCapture();
  await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-pair',
    url: new URL(`https://control.example.com/v0/node-rpc/device-pair?code=${encodeURIComponent(created.code)}`),
    req: { headers: {} },
    res: secondPairRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createNodeRpcDeps(aiHomeDir, pairBody)
  });
  assert.equal(secondPairRes.statusCode, 410);
  assert.match(secondPairRes.body, /device_invite_already_consumed/);

  const listRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/control-plane/devices',
    url: new URL('https://control.example.com/v0/webui/control-plane/devices'),
    req: { headers: {} },
    res: listRes,
    options: {},
    state: {},
    deps: createWebDeps(aiHomeDir)
  });
  assert.equal(listRes.statusCode, 200);
  assert.doesNotMatch(listRes.body, new RegExp(pairPayload.token));

  const revokeRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: `/v0/webui/control-plane/devices/${encodeURIComponent(pairPayload.device.id)}/revoke`,
    url: new URL(`https://control.example.com/v0/webui/control-plane/devices/${encodeURIComponent(pairPayload.device.id)}/revoke`),
    req: { headers: {} },
    res: revokeRes,
    options: {},
    state: {},
    deps: createWebDeps(aiHomeDir)
  });
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(JSON.parse(revokeRes.body).device.state, 'revoked');
  assert.equal(findControlPlaneDeviceByToken(pairPayload.token, { fs, aiHomeDir }), null);
});
