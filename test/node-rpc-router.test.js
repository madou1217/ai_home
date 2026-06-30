const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleNodeRpcRequest } = require('../lib/server/node-rpc-router');
const { serializeDeviceSession } = require('../lib/server/control-plane-device-sessions');
const { createRemoteNodeInvite } = require('../lib/server/remote/pairing');
const { getRemoteNode, upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { upsertRemoteTransport } = require('../lib/server/remote/transport-registry');
const { readRemoteSecret, writeRemoteSecret } = require('../lib/server/remote/secret-store');
const {
  consumeControlPlaneDeviceInvite,
  createControlPlaneDeviceInvite,
  revokeControlPlaneDevice
} = require('../lib/server/control-plane-device-pairing');

const NODE_RPC_CODEX_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const NODE_RPC_CLAUDE_ACCOUNT_REF = 'acct_abcdefabcdefabcdefab';

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    body: '',
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createSseResCapture() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.destroyed = false;
  res.writableEnded = false;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.writeHead = (code, headers = {}) => {
    res.statusCode = code;
    Object.entries(headers).forEach(([name, value]) => {
      res.headers[String(name).toLowerCase()] = value;
    });
  };
  res.write = (chunk = '') => {
    if (res.destroyed || res.writableEnded) return false;
    res.body += String(chunk);
    return true;
  };
  res.end = (chunk = '') => {
    if (chunk) res.body += String(chunk);
    res.writableEnded = true;
    res.emit('close');
  };
  return res;
}

function createReqCapture(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  return req;
}

function parseSseDataFrames(body) {
  return String(body || '')
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

function createDeps(overrides = {}) {
  const deps = {
    fs,
    aiHomeDir: overrides.aiHomeDir || '',
    parseAuthorizationBearer(value) {
      const text = String(value || '').trim();
      return text.toLowerCase().startsWith('bearer ') ? text.slice(7).trim() : '';
    },
    readRequestBody: async () => overrides.body || Buffer.alloc(0),
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    buildManagementStatusPayload() {
      return {
        ok: true,
        service: 'aih-server',
        providers: {}
      };
    },
    buildManagementAccountsPayload() {
      return {
        ok: true,
        accounts: []
      };
    },
    accountStateIndex: {}
  };
  if (typeof overrides.readSessionMessages === 'function') {
    deps.readSessionMessages = overrides.readSessionMessages;
  }
  if (typeof overrides.readSessionEvents === 'function') {
    deps.readSessionEvents = overrides.readSessionEvents;
  }
  if (typeof overrides.getSessionFileCursor === 'function') {
    deps.getSessionFileCursor = overrides.getSessionFileCursor;
  }
  if (typeof overrides.getProjectsSnapshot === 'function') {
    deps.getProjectsSnapshot = overrides.getProjectsSnapshot;
  }
  if (typeof overrides.setInterval === 'function') {
    deps.setInterval = overrides.setInterval;
  }
  if (typeof overrides.clearInterval === 'function') {
    deps.clearInterval = overrides.clearInterval;
  }
  if (typeof overrides.streamRemoteManagement === 'function') {
    deps.streamRemoteManagement = overrides.streamRemoteManagement;
  }
  if (typeof overrides.requestRemoteManagement === 'function') {
    deps.requestRemoteManagement = overrides.requestRemoteManagement;
  }
  if (typeof overrides.listNativeChatRuns === 'function') {
    deps.listNativeChatRuns = overrides.listNativeChatRuns;
  }
  if (typeof overrides.getNativeChatRun === 'function') {
    deps.getNativeChatRun = overrides.getNativeChatRun;
  }
  if (typeof overrides.readNativeSessionRunEvents === 'function') {
    deps.readNativeSessionRunEvents = overrides.readNativeSessionRunEvents;
  }
  if (typeof overrides.writeNativeSessionRunInput === 'function') {
    deps.writeNativeSessionRunInput = overrides.writeNativeSessionRunInput;
  }
  if (typeof overrides.abortNativeSessionRun === 'function') {
    deps.abortNativeSessionRun = overrides.abortNativeSessionRun;
  }
  if (typeof overrides.startNativeDeviceSession === 'function') {
    deps.startNativeDeviceSession = overrides.startNativeDeviceSession;
  }
  if (typeof overrides.getProfileDir === 'function') {
    deps.getProfileDir = overrides.getProfileDir;
  }
  if (typeof overrides.resolveSessionAccountId === 'function') {
    deps.resolveSessionAccountId = overrides.resolveSessionAccountId;
  }
  if (typeof overrides.ensureSessionStoreLinks === 'function') {
    deps.ensureSessionStoreLinks = overrides.ensureSessionStoreLinks;
  }
  if (typeof overrides.registerNativeChatRun === 'function') {
    deps.registerNativeChatRun = overrides.registerNativeChatRun;
  }
  if (typeof overrides.ackSessionEvents === 'function') {
    deps.ackSessionEvents = overrides.ackSessionEvents;
  }
  if (typeof overrides.readSessionArtifact === 'function') {
    deps.readSessionArtifact = overrides.readSessionArtifact;
  }
  if (typeof overrides.writeDeviceSessionInput === 'function') {
    deps.writeDeviceSessionInput = overrides.writeDeviceSessionInput;
  }
  if (typeof overrides.findNativeChatRunBySession === 'function') {
    deps.findNativeChatRunBySession = overrides.findNativeChatRunBySession;
  }
  if (typeof overrides.unregisterNativeChatRun === 'function') {
    deps.unregisterNativeChatRun = overrides.unregisterNativeChatRun;
  }
  if (typeof overrides.fetchImpl === 'function') {
    deps.fetchImpl = overrides.fetchImpl;
  }
  if (typeof overrides.requestRelayManagement === 'function') {
    deps.requestRelayManagement = overrides.requestRelayManagement;
  }
  if (overrides.relaySessionRegistry) {
    deps.relaySessionRegistry = overrides.relaySessionRegistry;
  }
  if (typeof overrides.requestRelayManagementStream === 'function') {
    deps.requestRelayManagementStream = overrides.requestRelayManagementStream;
  }
  if (overrides.deviceNodeStreamReconnects !== undefined) {
    deps.deviceNodeStreamReconnects = overrides.deviceNodeStreamReconnects;
  }
  if (overrides.deviceNodeStreamReconnectDelayMs !== undefined) {
    deps.deviceNodeStreamReconnectDelayMs = overrides.deviceNodeStreamReconnectDelayMs;
  }
  return deps;
}

test('node rpc router returns false outside node rpc namespace', async () => {
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/management/status',
    req: { headers: {} },
    res: createResCapture(),
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: createDeps()
  });

  assert.equal(handled, false);
});

test('node rpc status uses management auth and stable rpc envelope', async () => {
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status',
    req: { headers: { authorization: 'Bearer node-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'node-secret',
    deps: createDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.status.read');
  assert.equal(payload.result.service, 'aih-server');
});

test('node rpc status can include authorized local node diagnostics on demand', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-rpc-diagnostics-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status',
    url: new URL('https://control.example.com/v0/node-rpc/status?diagnostics=1&controlUrl=https%3A%2F%2Fcontrol.example.com&nodeId=office-pc'),
    req: { headers: { authorization: 'Bearer node-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'node-secret',
    deps: {
      ...createDeps({ aiHomeDir }),
      path,
      aiHomeDir,
      hostHomeDir: aiHomeDir,
      hostname: () => 'Office PC',
      platform: 'linux',
      arch: 'x64',
      processObj: {
        platform: 'linux',
        arch: 'x64',
        version: 'v24.1.0',
        execPath: '/usr/local/bin/node',
        env: { PATH: '/usr/local/bin:/usr/bin' }
      },
      readServerConfig: () => ({
        host: '127.0.0.1',
        port: 9527,
        managementKey: 'node-secret'
      }),
      networkInterfaces: () => ({
        eth0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }]
      }),
      spawnSync(command, args) {
        if (command === 'sh' && args[0] === '-lc') {
          const match = String(args[1] || '').match(/^command -v (.+)$/);
          const paths = { node: '/usr/local/bin/node', npm: '/usr/local/bin/npm', aih: '/usr/local/bin/aih' };
          const resolved = match ? paths[match[1]] : '';
          return resolved ? { status: 0, stdout: `${resolved}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        if (args[0] === '--version' && command === 'node') {
          return { status: 0, stdout: 'v24.1.0\n', stderr: '' };
        }
        if (args[0] === '--version' && command === 'npm') {
          return { status: 0, stdout: '11.0.0\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.result.nodeDiagnostics.node.id, 'office-pc');
  assert.equal(payload.result.nodeDiagnostics.service.state, 'missing');
  assert.match(payload.result.nodeDiagnostics.service.installHint, /https:\/\/control\.example\.com --node-id office-pc/);
  assert.doesNotMatch(res.body, /node-secret/);
});

test('node rpc diagnostics read running supervised services through user systemd env', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-rpc-systemd-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serviceDir = path.join(root, '.config', 'systemd', 'user');
  fs.mkdirSync(serviceDir, { recursive: true });
  [
    'com.clawdcodex.ai_home.node-relay.office-pc.service',
    'com.clawdcodex.ai_home.fabric-registry-agent.office-pc.service',
    'com.clawdcodex.ai_home.node-webrtc.office-pc.service'
  ].forEach((file) => {
    fs.writeFileSync(path.join(serviceDir, file), '[Service]\nExecStart=aih\n');
  });

  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status',
    url: new URL('https://control.example.com/v0/node-rpc/status?diagnostics=1&controlUrl=https%3A%2F%2Fcontrol.example.com&nodeId=office-pc'),
    req: { headers: { authorization: 'Bearer node-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'node-secret',
    deps: {
      ...createDeps({ aiHomeDir: path.join(root, '.ai_home') }),
      path,
      aiHomeDir: path.join(root, '.ai_home'),
      hostHomeDir: root,
      hostname: () => 'Office PC',
      platform: 'linux',
      arch: 'x64',
      processObj: {
        platform: 'linux',
        arch: 'x64',
        version: 'v24.1.0',
        execPath: '/usr/local/bin/node',
        env: { PATH: '/usr/local/bin:/usr/bin' },
        getuid: () => 1000
      },
      readServerConfig: () => ({
        host: '0.0.0.0',
        port: 9527,
        managementKey: 'node-secret',
        openNetwork: true
      }),
      networkInterfaces: () => ({
        eth0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }]
      }),
      spawnSync(command, args, options = {}) {
        if (command === 'sh' && args[0] === '-lc') {
          const match = String(args[1] || '').match(/^command -v (.+)$/);
          const paths = { node: '/usr/local/bin/node', npm: '/usr/local/bin/npm', aih: '/usr/local/bin/aih' };
          const resolved = match ? paths[match[1]] : '';
          return resolved ? { status: 0, stdout: `${resolved}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        if (args[0] === '--version' && command === 'node') {
          return { status: 0, stdout: 'v24.1.0\n', stderr: '' };
        }
        if (args[0] === '--version' && command === 'npm') {
          return { status: 0, stdout: '11.0.0\n', stderr: '' };
        }
        if (command === 'systemctl' && args[0] === '--version') {
          return { status: 0, stdout: 'systemd 255\n', stderr: '' };
        }
        if (command === 'systemctl'
          && args[0] === '--user'
          && (args[1] === 'is-enabled' || args[1] === 'is-active')) {
          assert.equal(options.env.XDG_RUNTIME_DIR, '/run/user/1000');
          assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
          return { status: 0, stdout: args[1] === 'is-active' ? 'active\n' : 'enabled\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  const diagnostics = payload.result.nodeDiagnostics;
  assert.equal(diagnostics.services.relay.running, true);
  assert.equal(diagnostics.services.registryAgent.running, true);
  assert.equal(diagnostics.services.webrtc.running, true);
  assert.equal(diagnostics.nodeSupervisor.ready, true);
  assert.doesNotMatch(res.body, /node-secret/);
});

test('node rpc diagnostics prefer current runtime server options over stale stored config', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-rpc-runtime-diagnostics-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status',
    url: new URL('https://control.example.com/v0/node-rpc/status?diagnostics=1&controlUrl=https%3A%2F%2Fcontrol.example.com&nodeId=office-pc'),
    req: { headers: { authorization: 'Bearer runtime-secret' } },
    res,
    options: {
      host: '0.0.0.0',
      port: 9527,
      managementKey: 'runtime-secret',
      openNetwork: true
    },
    state: {},
    requiredManagementKey: 'runtime-secret',
    deps: {
      ...createDeps({ aiHomeDir }),
      path,
      aiHomeDir,
      hostHomeDir: aiHomeDir,
      hostname: () => 'Office PC',
      platform: 'linux',
      arch: 'x64',
      processObj: {
        platform: 'linux',
        arch: 'x64',
        version: 'v24.1.0',
        execPath: '/usr/local/bin/node',
        env: { PATH: '/usr/local/bin:/usr/bin' }
      },
      readServerConfig: () => ({
        host: '127.0.0.1',
        port: 9527,
        managementKey: ''
      }),
      networkInterfaces: () => ({
        eth0: [{ family: 'IPv4', address: '192.168.3.8', internal: false }]
      }),
      spawnSync(command, args) {
        if (command === 'sh' && args[0] === '-lc') {
          const match = String(args[1] || '').match(/^command -v (.+)$/);
          const paths = { node: '/usr/local/bin/node', npm: '/usr/local/bin/npm', aih: '/usr/local/bin/aih' };
          const resolved = match ? paths[match[1]] : '';
          return resolved ? { status: 0, stdout: `${resolved}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        if (args[0] === '--version' && command === 'node') {
          return { status: 0, stdout: 'v24.1.0\n', stderr: '' };
        }
        if (args[0] === '--version' && command === 'npm') {
          return { status: 0, stdout: '11.0.0\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.result.nodeDiagnostics.server.host, '0.0.0.0');
  assert.equal(payload.result.nodeDiagnostics.server.managementKeyConfigured, true);
  assert.equal(
    payload.result.nodeDiagnostics.issues.some((issue) => issue.code === 'management_key_missing'),
    false
  );
  assert.doesNotMatch(res.body, /runtime-secret/);
});

test('node rpc descriptor is public and does not leak configured keys', async () => {
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/descriptor',
    url: new URL('https://control.example.com/v0/node-rpc/descriptor'),
    req: {
      headers: {
        host: '127.0.0.1:9527',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'aih.example.com'
      }
    },
    res,
    options: {
      host: '0.0.0.0',
      port: 9527,
      clientKey: 'client-secret'
    },
    state: {
      startedAt: Date.now() - 5000
    },
    requiredManagementKey: 'management-secret',
    deps: createDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.match(res.headers['access-control-allow-headers'], /content-type/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.descriptor.read');
  assert.equal(payload.result.service, 'aih-control-plane');
  assert.equal(payload.result.endpoint, 'https://aih.example.com');
  assert.equal(payload.result.auth.managementKeyConfigured, true);
  assert.equal(payload.result.auth.clientKeyConfigured, true);
  assert.ok(payload.result.capabilities.nodeRpc.includes('session-messages'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('session-stream'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('session-command'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('session-ack'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('session-artifact'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('join'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-pair'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-status'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-accounts'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-sessions'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-session-events'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-session-stream'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-sessions'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-messages'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-stream'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-input'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-command'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-ack'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-node-session-artifact'));
  assert.ok(payload.result.capabilities.nodeRpc.includes('device-nodes'));
  assert.equal(payload.result.capabilities.devicePairing, true);
  assert.ok(payload.result.capabilities.transports.includes('relay'));
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /client-secret/);
});

test('node rpc public pairing endpoints answer CORS preflight without auth', async () => {
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'OPTIONS',
    pathname: '/v0/node-rpc/device-pair',
    url: new URL('https://control.example.com/v0/node-rpc/device-pair'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.match(res.headers['access-control-allow-headers'], /content-type/);
});

test('node rpc device pair GET redirects browsers to web pairing entry', async () => {
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-pair',
    url: new URL('https://control.example.com/v0/node-rpc/device-pair?code=pair-code'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers['cache-control'], 'no-store');
  const location = new URL(res.headers.location);
  assert.equal(location.toString(), 'https://control.example.com/ui/settings?pair=https%3A%2F%2Fcontrol.example.com%2Fv0%2Fnode-rpc%2Fdevice-pair%3Fcode%3Dpair-code');
  assert.equal(location.searchParams.get('pair'), 'https://control.example.com/v0/node-rpc/device-pair?code=pair-code');
});

test('node rpc device profile uses scoped device bearer without leaking secrets', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-profile-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['control-plane:read', 'nodes:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      name: 'iPhone',
      platform: 'ios'
    }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-profile',
    url: new URL('https://control.example.com/v0/node-rpc/device-profile'),
    req: {
      headers: {
        authorization: `Bearer ${paired.token}`,
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res,
    options: {
      host: '0.0.0.0',
      port: 9527,
      clientKey: 'client-secret'
    },
    state: {
      startedAt: Date.now() - 2000
    },
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.profile');
  assert.equal(payload.result.device.id, paired.device.id);
  assert.equal(payload.result.device.platform, 'ios');
  assert.equal(payload.result.controlPlane.service, 'aih-control-plane');
  assert.ok(payload.result.controlPlane.capabilities.nodeRpc.includes('device-profile'));
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, new RegExp(invite.code));
  assert.doesNotMatch(res.body, /deviceTokenHashes|inviteCodeHashes/);
});

test('node rpc device profile rejects missing, wrong, and revoked tokens; paired tokens have full access', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-profile-auth-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  async function requestProfile(authorization) {
    const res = createResCapture();
    await handleNodeRpcRequest({
      method: 'GET',
      pathname: '/v0/node-rpc/device-profile',
      url: new URL('https://control.example.com/v0/node-rpc/device-profile'),
      req: { headers: authorization ? { authorization } : {} },
      res,
      options: {},
      state: {},
      requiredManagementKey: 'management-secret',
      deps: createDeps({ aiHomeDir })
    });
    return res;
  }

  const missingRes = await requestProfile('');
  assert.equal(missingRes.statusCode, 401);
  assert.match(missingRes.body, /unauthorized_control_plane_device/);

  const wrongRes = await requestProfile('Bearer wrong-token');
  assert.equal(wrongRes.statusCode, 401);
  assert.match(wrongRes.body, /unauthorized_control_plane_device/);

  const fullAccessInvite = createControlPlaneDeviceInvite({
    name: 'Paired Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read']
  }, { fs, aiHomeDir });
  const fullAccess = consumeControlPlaneDeviceInvite({
    code: fullAccessInvite.code,
    device: { name: 'Paired Phone', platform: 'android' }
  }, { fs, aiHomeDir });
  const fullAccessRes = await requestProfile(`Bearer ${fullAccess.token}`);
  assert.equal(fullAccessRes.statusCode, 200);
  assert.match(fullAccessRes.body, /control_plane\.device\.profile/);
  assert.doesNotMatch(fullAccessRes.body, new RegExp(fullAccess.token));

  const validInvite = createControlPlaneDeviceInvite({
    name: 'Revoked Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['control-plane:read']
  }, { fs, aiHomeDir });
  const revoked = consumeControlPlaneDeviceInvite({
    code: validInvite.code,
    device: { name: 'Revoked Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  revokeControlPlaneDevice(revoked.device.id, { fs, aiHomeDir });
  const revokedRes = await requestProfile(`Bearer ${revoked.token}`);
  assert.equal(revokedRes.statusCode, 401);
  assert.match(revokedRes.body, /unauthorized_control_plane_device/);
});

test('node rpc device nodes lists scoped node summaries without leaking connection secrets', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-nodes-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const node = upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    role: 'workstation',
    capabilities: ['status', 'accounts'],
    preferredTransports: ['tailscale', 'frp'],
    tags: ['office']
  }, { fs, aiHomeDir });
  upsertRemoteTransport({
    id: 'office-pc-tailnet',
    nodeId: node.id,
    kind: 'tailscale',
    endpoint: 'http://100.64.0.8:9527',
    status: 'up',
    score: 91,
    latencyMs: 24,
    provider: 'tailscale',
    routeRole: 'data-plane',
    trustLevel: 'verified',
    setupHint: 'tailnet endpoint is private'
  }, { fs, aiHomeDir });
  writeRemoteSecret(node.authRef, { managementKey: 'node-management-secret' }, { fs, aiHomeDir });

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-nodes',
    url: new URL('https://control.example.com/v0/node-rpc/device-nodes'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.nodes');
  assert.equal(payload.result.nodes.length, 1);
  assert.equal(payload.result.nodes[0].id, 'office-pc');
  assert.equal(payload.result.nodes[0].transports[0].kind, 'tailscale');
  assert.equal(payload.result.nodes[0].transports[0].status, 'up');
  assert.equal(payload.result.nodes[0].transports[0].score, 91);
  assert.equal(payload.result.nodes[0].transports[0].provider, 'tailscale');
  assert.equal(payload.result.nodes[0].transports[0].routeRole, 'data-plane');
  assert.equal(payload.result.nodes[0].transports[0].trustLevel, 'verified');
  assert.equal(payload.result.nodes[0].connection.status, 'unknown');
  assert.doesNotMatch(res.body, /node-management-secret/);
  assert.doesNotMatch(res.body, /remote-node\/office-pc/);
  assert.doesNotMatch(res.body, /100\.64\.0\.8/);
  assert.doesNotMatch(res.body, /tailnet endpoint is private/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device nodes includes active relay connection state for mobile clients', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-nodes-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const node = upsertRemoteNode({
    id: 'home-win',
    name: 'Home Windows',
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  upsertRemoteTransport({
    id: 'home-win-relay',
    nodeId: node.id,
    kind: 'relay',
    status: 'up',
    score: 55,
    provider: 'aih-relay',
    routeRole: 'data-plane',
    trustLevel: 'managed'
  }, { fs, aiHomeDir });

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-nodes',
    url: new URL('https://control.example.com/v0/node-rpc/device-nodes'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      relaySessionRegistry: {
        getRelaySession: () => ({
          sessionId: 'relay-session-1',
          nodeId: 'home-win',
          transportId: 'home-win-relay',
          remoteAddress: '203.0.113.10',
          connectedAt: 1000,
          lastSeenAt: 2000
        })
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.result.nodes.length, 1);
  assert.equal(payload.result.nodes[0].connection.status, 'online');
  assert.equal(payload.result.nodes[0].connection.transportKind, 'relay');
  assert.equal(payload.result.nodes[0].connection.transportId, 'home-win-relay');
  assert.equal(payload.result.nodes[0].connection.sessionId, 'relay-session-1');
  assert.equal(payload.result.nodes[0].connection.lastSeenAt, 2000);
});

test('node rpc device status returns scoped aggregate status without leaking local management details', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-status-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['status:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const deps = createDeps({ aiHomeDir });
  deps.buildManagementStatusPayload = () => ({
    ok: true,
    backend: 'codex-adapter',
    host: '127.0.0.1',
    port: 9527,
    apiKeyConfigured: true,
    providerMode: 'auto',
    strategy: 'round-robin',
    totalAccounts: 3,
    activeAccounts: 2,
    cooldownAccounts: 1,
    statusTotals: { healthy: 2, rate_limited: 1 },
    providers: {
      codex: { total: 3, active: 2, statuses: { healthy: 2, rate_limited: 1 } }
    },
    queue: {
      codex: {
        name: 'codex',
        running: 1,
        queued: 0,
        maxConcurrency: 2,
        queueLimit: 20,
        totalScheduled: 5,
        totalRejected: 0
      }
    },
    modelsCached: 7,
    modelsUpdatedAt: 1000,
    modelRegistryUpdatedAt: 2000,
    successRate: 0.75,
    timeoutRate: 0.05,
    totalRequests: 20,
    uptimeSec: 30,
    secret: 'local-secret-should-not-leak',
    accounts: [{ id: 'internal-account-id', token: 'account-secret' }]
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-status',
    url: new URL('https://control.example.com/v0/node-rpc/device-status'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.status');
  assert.equal(payload.result.status.service, 'aih-control-plane');
  assert.equal(payload.result.status.totalAccounts, 3);
  assert.equal(payload.result.status.activeAccounts, 2);
  assert.equal(payload.result.status.queueTotals.running, 1);
  assert.equal(payload.result.status.providers.codex.statuses.rate_limited, 1);
  assert.doesNotMatch(res.body, /127\.0\.0\.1/);
  assert.doesNotMatch(res.body, /9527/);
  assert.doesNotMatch(res.body, /apiKeyConfigured/);
  assert.doesNotMatch(res.body, /local-secret-should-not-leak/);
  assert.doesNotMatch(res.body, /internal-account-id/);
  assert.doesNotMatch(res.body, /account-secret/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device status accepts any paired device token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-status-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Nodes Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Nodes Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-status',
    url: new URL('https://control.example.com/v0/node-rpc/device-status'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /control_plane\.device\.status/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device accounts returns scoped sanitized account summaries', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-accounts-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const deps = createDeps({ aiHomeDir });
  deps.buildManagementAccountsPayload = () => ({
    ok: true,
    accounts: [
      {
        id: 'local-1',
        accountRef: NODE_RPC_CODEX_ACCOUNT_REF,
        accountId: 'acct-internal-1',
        provider: 'codex',
        email: 'user@example.com',
        status: 'up',
        apiKeyMode: false,
        planType: 'plus',
        runtimeStatus: 'healthy',
        quotaStatus: 'available',
        schedulableStatus: 'schedulable',
        remainingPct: 72,
        modelCooldownCount: 0,
        lastRefresh: 1234,
        successCount: 5,
        failCount: 1,
        hasAccessToken: true,
        hasRefreshToken: true,
        usageSnapshot: {
          account: { accountId: 'upstream-account-id' },
          entries: []
        },
        lastError: 'secret upstream error'
      },
      {
        id: 'local-2',
        accountRef: NODE_RPC_CLAUDE_ACCOUNT_REF,
        accountId: 'acct-internal-2',
        provider: 'claude',
        email: '',
        baseUrl: 'https://proxy.example.com/v1',
        status: 'down',
        apiKeyMode: true,
        planType: 'api-key',
        runtimeStatus: 'auth_invalid',
        quotaStatus: 'unknown',
        schedulableStatus: 'blocked_by_auth',
        remainingPct: null,
        modelCooldownCount: 2,
        lastRefresh: 0,
        successCount: 0,
        failCount: 3
      }
    ]
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-accounts',
    url: new URL('https://control.example.com/v0/node-rpc/device-accounts'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.accounts');
  assert.equal(payload.result.accounts.length, 2);
  const codexAccount = payload.result.accounts.find((account) => account.provider === 'codex');
  const claudeAccount = payload.result.accounts.find((account) => account.provider === 'claude');
  assert.match(codexAccount.accountRef, /^acct_[a-f0-9]{20}$/);
  assert.equal(codexAccount.label, 'user@example.com');
  assert.equal(codexAccount.remainingPct, 72);
  assert.equal(claudeAccount.authMode, 'api-key');
  assert.equal(payload.result.summary.total, 2);
  assert.equal(payload.result.summary.active, 1);
  assert.equal(payload.result.summary.byProvider.codex, 1);
  assert.equal(payload.result.summary.bySchedulableStatus.schedulable, 1);
  assert.doesNotMatch(res.body, /local-1/);
  assert.doesNotMatch(res.body, /acct-internal/);
  assert.doesNotMatch(res.body, /proxy\.example\.com/);
  assert.doesNotMatch(res.body, /hasAccessToken/);
  assert.doesNotMatch(res.body, /hasRefreshToken/);
  assert.doesNotMatch(res.body, /usageSnapshot/);
  assert.doesNotMatch(res.body, /upstream-account-id/);
  assert.doesNotMatch(res.body, /secret upstream error/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device provider account reauth starts oauth job through paired token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-provider-reauth-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Desktop',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Desktop', platform: 'macos' }
  }, { fs, aiHomeDir });

  const startedCalls = [];
  const upserts = [];
  const body = Buffer.from(JSON.stringify({
    provider: 'codex',
    accountId: '42'
  }), 'utf8');
  const deps = createDeps({ aiHomeDir, body });
  deps.accountStateIndex = {
    getAccountState() {
      return {
        display_name: 'codex-user',
        api_key_mode: false,
        auth_mode: 'oauth-browser',
        status: 'up',
        configured: true
      };
    }
  };
  deps.accountStateService = {
    syncAccountBaseState(provider, accountId, state) {
      upserts.push({ provider, accountId, state });
    }
  };
  deps.getToolAccountIds = () => ['42'];
  deps.getProfileDir = (provider, accountId) => path.join(aiHomeDir, 'profiles', provider, accountId);
  deps.getToolConfigDir = (provider, accountId) => path.join(aiHomeDir, 'profiles', provider, accountId, '.codex');
  deps.checkStatus = () => ({ configured: true, accountName: 'codex-user' });
  deps.getAuthJobManager = () => ({
    startOauthJob(provider, authMode, options) {
      startedCalls.push({ provider, authMode, options });
      return {
        jobId: 'job-42',
        provider,
        accountId: options.accountId,
        expiresAt: 12345,
        pollIntervalMs: 5000,
        authorizationUrl: 'https://login.example.com/oauth'
      };
    }
  });

  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-provider-account-reauth',
    url: new URL('https://control.example.com/v0/node-rpc/device-provider-account-reauth'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.provider_account_reauth');
  assert.equal(payload.result.jobId, 'job-42');
  assert.equal(payload.result.targetAccountId, '42');
  assert.equal(payload.result.authorizationUrl, 'https://login.example.com/oauth');
  assert.deepEqual(startedCalls.map((call) => ({
    provider: call.provider,
    authMode: call.authMode,
    accountId: call.options.accountId
  })), [{
    provider: 'codex',
    authMode: 'oauth-browser',
    accountId: '42'
  }]);
  assert.equal(upserts[0].provider, 'codex');
  assert.equal(upserts[0].accountId, '42');
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device provider auth job get cancel and callback use paired token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-provider-auth-job-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Desktop',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Desktop', platform: 'macos' }
  }, { fs, aiHomeDir });

  const job = {
    id: 'job-42',
    provider: 'agy',
    accountId: '8',
    authMode: 'oauth-browser',
    status: 'running',
    authProgressState: 'awaiting_code',
    authorizationUrl: 'https://login.example.com/oauth',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const callbackCalls = [];
  const cancelCalls = [];
  const cleanupCalls = [];
  const deps = createDeps({ aiHomeDir });
  deps.getAuthJobManager = () => ({
    getJob(jobId) {
      return jobId === 'job-42' ? job : null;
    },
    cancelJob(jobId) {
      cancelCalls.push(jobId);
      return {
        ok: true,
        job: {
          ...job,
          status: 'cancelled',
          authProgressState: 'cancelled',
          error: 'user cancelled'
        }
      };
    },
    completeBrowserOauthCallback(jobId, callbackUrl) {
      callbackCalls.push({ jobId, callbackUrl });
      return {
        ok: true,
        job: {
          ...job,
          status: 'succeeded',
          authProgressState: 'completed'
        }
      };
    }
  });
  deps.cleanupAuthJobArtifacts = (cleanedJob) => cleanupCalls.push(cleanedJob.id);

  const getRes = createResCapture();
  const getHandled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-provider-account-auth-job',
    url: new URL('https://control.example.com/v0/node-rpc/device-provider-account-auth-job?jobId=job-42'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res: getRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });
  assert.equal(getHandled, true);
  assert.equal(getRes.statusCode, 200);
  const getPayload = JSON.parse(getRes.body);
  assert.equal(getPayload.rpc, 'control_plane.device.provider_account_auth_job');
  assert.equal(getPayload.result.job.id, 'job-42');
  assert.equal(getPayload.result.job.authorizationUrl, 'https://login.example.com/oauth');

  const cancelRes = createResCapture();
  const cancelDeps = {
    ...deps,
    readRequestBody: async () => Buffer.from(JSON.stringify({ jobId: 'job-42' }), 'utf8')
  };
  const cancelHandled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-provider-account-auth-job-cancel',
    url: new URL('https://control.example.com/v0/node-rpc/device-provider-account-auth-job-cancel'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res: cancelRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: cancelDeps
  });
  assert.equal(cancelHandled, true);
  assert.equal(cancelRes.statusCode, 200);
  const cancelPayload = JSON.parse(cancelRes.body);
  assert.equal(cancelPayload.result.action, 'cancel');
  assert.equal(cancelPayload.result.job.status, 'cancelled');
  assert.deepEqual(cancelCalls, ['job-42']);
  assert.deepEqual(cleanupCalls, ['job-42']);

  const callbackRes = createResCapture();
  const callbackDeps = {
    ...deps,
    readRequestBody: async () => Buffer.from(JSON.stringify({
      jobId: 'job-42',
      code: '4/0AgyAuthorizationCode'
    }), 'utf8')
  };
  const callbackHandled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-provider-account-auth-job-callback',
    url: new URL('https://control.example.com/v0/node-rpc/device-provider-account-auth-job-callback'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res: callbackRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: callbackDeps
  });
  assert.equal(callbackHandled, true);
  assert.equal(callbackRes.statusCode, 200);
  const callbackPayload = JSON.parse(callbackRes.body);
  assert.equal(callbackPayload.result.action, 'callback');
  assert.equal(callbackPayload.result.job.status, 'succeeded');
  assert.deepEqual(callbackCalls, [{
    jobId: 'job-42',
    callbackUrl: '4/0AgyAuthorizationCode'
  }]);
  assert.doesNotMatch(getRes.body + cancelRes.body + callbackRes.body, new RegExp(paired.token));
});

test('node rpc device accounts accepts any paired device token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-accounts-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Status Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['status:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Status Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-accounts',
    url: new URL('https://control.example.com/v0/node-rpc/device-accounts'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /control_plane\.device\.accounts/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device sessions returns scoped sanitized session summaries', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-sessions-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const deps = createDeps({ aiHomeDir });
  deps.getProjectsSnapshot = async () => ({
    projects: [
      {
        id: 'project-internal-id',
        name: 'AI Home',
        path: '/Users/model/projects/feature/ai_home',
        providers: ['codex'],
        sessions: [
          {
            id: 'raw-session-id-1',
            title: 'Remote control design',
            provider: 'codex',
            projectDirName: 'Users-model-projects-feature-ai_home',
            projectPath: '/Users/model/projects/feature/ai_home',
            transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
            updatedAt: 2000,
            startedAt: 1000,
            status: 'running'
          }
        ]
      }
    ]
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-sessions',
    url: new URL('https://control.example.com/v0/node-rpc/device-sessions'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.sessions');
  assert.equal(payload.result.sessions.length, 1);
  assert.match(payload.result.sessions[0].sessionRef, /^sess_[a-f0-9]{20}$/);
  assert.match(payload.result.sessions[0].projectRef, /^proj_[a-f0-9]{20}$/);
  assert.equal(payload.result.sessions[0].provider, 'codex');
  assert.equal(payload.result.sessions[0].title, 'Remote control design');
  assert.equal(payload.result.sessions[0].projectName, 'AI Home');
  assert.equal(payload.result.sessions[0].status, 'running');
  assert.equal(payload.result.summary.total, 1);
  assert.equal(payload.result.summary.returned, 1);
  assert.equal(payload.result.summary.byProvider.codex, 1);
  assert.equal(payload.result.summary.byStatus.running, 1);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /Users-model-projects-feature-ai_home/);
  assert.doesNotMatch(res.body, /transcriptPath/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device session messages resolve public session ref without exposing local ids or paths', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-messages-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    providers: ['codex'],
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote control design',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const observedReaderCalls = [];
  const deps = createDeps({
    aiHomeDir,
    getProjectsSnapshot: async () => ({ projects: [project] }),
    readSessionMessages: (provider, params) => {
      observedReaderCalls.push({ provider, params });
      return [
        { role: 'system', content: 'system prompt', timestamp: 1000, localPath: '/tmp/hidden' },
        { role: 'user', content: 'please continue', timestamp: 1500, images: ['/Users/model/secret.png'] },
        { role: 'assistant', content: 'continuing now', timestamp: 2000 }
      ];
    },
    getSessionFileCursor: (provider, params) => {
      observedReaderCalls.push({ provider, params, cursor: true });
      return 4096;
    }
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-messages',
    url: new URL(`https://control.example.com/v0/node-rpc/device-session-messages?sessionRef=${publicSession.sessionRef}&limit=2`),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.session_messages');
  assert.equal(payload.result.session.sessionRef, publicSession.sessionRef);
  assert.equal(payload.result.session.projectRef, publicSession.projectRef);
  assert.deepEqual(payload.result.messages.map((message) => [message.role, message.content]), [
    ['user', 'please continue'],
    ['assistant', 'continuing now']
  ]);
  assert.equal(payload.result.summary.total, 2);
  assert.equal(payload.result.summary.returned, 2);
  assert.equal(payload.result.summary.truncated, false);
  assert.equal(payload.result.summary.cursor, 4096);
  assert.deepEqual(observedReaderCalls[0], {
    provider: 'codex',
    params: {
      sessionId: 'raw-session-id-1',
      projectDirName: 'Users-model-projects-feature-ai_home'
    }
  });
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /Users-model-projects-feature-ai_home/);
  assert.doesNotMatch(res.body, /transcriptPath/);
  assert.doesNotMatch(res.body, /localPath/);
  assert.doesNotMatch(res.body, /secret\.png/);
  assert.doesNotMatch(res.body, /system prompt/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc management session messages uses management bearer and safe payloads', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-messages-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    providers: ['codex'],
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote control design',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const deps = createDeps({
    aiHomeDir,
    getProjectsSnapshot: async () => ({ projects: [project] }),
    readSessionMessages: () => [
      { role: 'system', content: 'system prompt', timestamp: 1000 },
      { role: 'user', content: 'remote question', timestamp: 1500, images: ['/Users/model/secret.png'] },
      { role: 'assistant', content: 'remote answer', timestamp: 2000 }
    ],
    getSessionFileCursor: () => 4096
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-messages',
    url: new URL(`https://node.local/v0/node-rpc/session-messages?sessionRef=${publicSession.sessionRef}&limit=2`),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_messages');
  assert.deepEqual(payload.result.messages.map((message) => [message.role, message.content]), [
    ['user', 'remote question'],
    ['assistant', 'remote answer']
  ]);
  assert.equal(payload.result.summary.cursor, 4096);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /transcriptPath/);
  assert.doesNotMatch(res.body, /secret\.png/);
  assert.doesNotMatch(res.body, /system prompt/);
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc device session events resolve public session ref and filter unsafe tool events', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-events-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    providers: ['codex'],
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote control design',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const observedReaderCalls = [];
  const deps = createDeps({
    aiHomeDir,
    getProjectsSnapshot: async () => ({ projects: [project] }),
    readSessionEvents: (provider, params, options) => {
      observedReaderCalls.push({ provider, params, options });
      return {
        events: [
          { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue', images: ['/Users/model/secret.png'] },
          { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' },
          { type: 'assistant_tool_result', timestamp: '2026-06-19T00:00:02.000Z', content: '# cwd: /Users/model/projects/feature/ai_home' }
        ],
        cursor: 8192,
        requiresSnapshot: false
      };
    }
  });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-events',
    url: new URL(`https://control.example.com/v0/node-rpc/device-session-events?sessionRef=${publicSession.sessionRef}&cursor=4096&limit=20`),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.session_events');
  assert.equal(payload.result.session.sessionRef, publicSession.sessionRef);
  assert.equal(payload.result.cursor, 8192);
  assert.equal(payload.result.requiresSnapshot, true);
  assert.equal(payload.result.truncated, false);
  assert.deepEqual(payload.result.events, [
    { seq: 8190, cursor: 8190, type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' },
    { seq: 8191, cursor: 8191, type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'continuing now' }
  ]);
  assert.deepEqual(observedReaderCalls[0], {
    provider: 'codex',
    params: {
      sessionId: 'raw-session-id-1',
      projectDirName: 'Users-model-projects-feature-ai_home'
    },
    options: { cursor: 4096 }
  });
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /Users-model-projects-feature-ai_home/);
  assert.doesNotMatch(res.body, /transcriptPath/);
  assert.doesNotMatch(res.body, /secret\.png/);
  assert.doesNotMatch(res.body, /assistant_tool_result/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device session stream emits safe SSE frames and clears poll timer on close', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-stream-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    providers: ['codex'],
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote control design',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const observedReaderCalls = [];
  const intervals = [];
  const clearedIntervals = [];
  const deps = createDeps({
    aiHomeDir,
    getProjectsSnapshot: async () => ({ projects: [project] }),
    readSessionEvents: (provider, params, options) => {
      observedReaderCalls.push({ provider, params, options });
      if (Number(options && options.cursor) === 8192) {
        return {
          events: [
            { type: 'assistant_text', timestamp: '2026-06-19T00:00:03.000Z', text: 'second update' }
          ],
          cursor: 9000,
          requiresSnapshot: false
        };
      }
      return {
        events: [
          { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue', images: ['/Users/model/secret.png'] },
          { type: 'assistant_tool_result', timestamp: '2026-06-19T00:00:02.000Z', content: '# cwd: /Users/model/projects/feature/ai_home' }
        ],
        cursor: 8192,
        requiresSnapshot: false
      };
    },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      clearedIntervals.push(timer);
    }
  });
  const req = createReqCapture({ authorization: `Bearer ${paired.token}` });
  const res = createSseResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-stream',
    url: new URL(`https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=${publicSession.sessionRef}&cursor=4096&limit=20&intervalMs=750`),
    req,
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 750);
  assert.equal(intervals[0].unrefCalled, true);

  const firstFrames = parseSseDataFrames(res.body);
  assert.equal(firstFrames.length, 1);
  assert.equal(firstFrames[0].ok, true);
  assert.equal(firstFrames[0].rpc, 'control_plane.device.session_stream');
  assert.equal(firstFrames[0].type, 'events');
  assert.equal(firstFrames[0].result.session.sessionRef, publicSession.sessionRef);
  assert.equal(firstFrames[0].result.cursor, 8192);
  assert.equal(firstFrames[0].result.requiresSnapshot, true);
  assert.deepEqual(firstFrames[0].result.events, [
    { seq: 8191, cursor: 8191, type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'please continue' }
  ]);

  intervals[0].fn();
  const frames = parseSseDataFrames(res.body);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].result.cursor, 9000);
  assert.deepEqual(frames[1].result.events, [
    { seq: 9000, cursor: 9000, type: 'assistant_text', timestamp: '2026-06-19T00:00:03.000Z', text: 'second update' }
  ]);
  assert.deepEqual(observedReaderCalls.map((call) => call.options), [
    { cursor: 4096 },
    { cursor: 8192 }
  ]);

  req.emit('close');
  assert.equal(clearedIntervals.length, 1);
  const bodyAfterClose = res.body;
  intervals[0].fn();
  assert.equal(res.body, bodyAfterClose);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /Users-model-projects-feature-ai_home/);
  assert.doesNotMatch(res.body, /transcriptPath/);
  assert.doesNotMatch(res.body, /secret\.png/);
  assert.doesNotMatch(res.body, /assistant_tool_result/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc management session stream uses management bearer and safe event payloads', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-stream-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote relay stream',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        transcriptPath: '/Users/model/.codex/sessions/raw-session-id-1.jsonl',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const intervals = [];
  const deps = createDeps({
    aiHomeDir,
    getProjectsSnapshot: async () => ({ projects: [project] }),
    readSessionEvents: () => ({
      events: [
        { type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'phone read only', images: ['/Users/model/secret.png'] },
        { type: 'assistant_tool_result', timestamp: '2026-06-19T00:00:02.000Z', content: '# cwd: /Users/model/projects/feature/ai_home' }
      ],
      cursor: 8192,
      requiresSnapshot: false
    }),
    setInterval: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval: () => {}
  });
  const req = createReqCapture({ authorization: 'Bearer management-secret' });
  const res = createSseResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-stream',
    url: new URL(`https://node.local/v0/node-rpc/session-stream?sessionRef=${publicSession.sessionRef}&cursor=4096&limit=20&intervalMs=750`),
    req,
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 750);
  const frames = parseSseDataFrames(res.body);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rpc, 'node.session_stream');
  assert.equal(frames[0].result.session.sessionRef, publicSession.sessionRef);
  assert.deepEqual(frames[0].result.events, [
    { seq: 8191, cursor: 8191, type: 'user_message', timestamp: '2026-06-19T00:00:00.000Z', content: 'phone read only' }
  ]);
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /secret\.png/);
  assert.doesNotMatch(res.body, /assistant_tool_result/);
});

test('node rpc management session input writes to active native run by public session ref', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-input-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote input',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const publicSession = serializeDeviceSession(project, project.sessions[0]);
  const writes = [];
  let observedLookup = null;
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-input',
    url: new URL('https://node.local/v0/node-rpc/session-input'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        sessionRef: publicSession.sessionRef,
        input: ' ',
        appendNewline: false,
        promptId: 'codex-plan-active'
      }), 'utf8'),
      getProjectsSnapshot: async () => ({ projects: [project] }),
      findNativeChatRunBySession: (input) => {
        observedLookup = input;
        return {
          runId: 'native-run-1',
          writeInput(value, options) {
            writes.push({ value, options });
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(observedLookup, {
    provider: 'codex',
    sessionId: 'raw-session-id-1',
    projectDirName: 'Users-model-projects-feature-ai_home'
  });
  assert.deepEqual(writes, [
    {
      value: ' ',
      options: { appendNewline: false, promptId: 'codex-plan-active' }
    }
  ]);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_input');
  assert.equal(payload.result.accepted, true);
  assert.equal(payload.result.session.sessionRef, publicSession.sessionRef);
  assert.doesNotMatch(res.body, /native-run-1/);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc management sessions lists safe public refs without internal session ids', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-sessions-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const project = {
    id: 'project-internal-id',
    name: 'AI Home',
    path: '/Users/model/projects/feature/ai_home',
    sessions: [
      {
        id: 'raw-session-id-1',
        title: 'Remote design',
        provider: 'codex',
        projectDirName: 'Users-model-projects-feature-ai_home',
        projectPath: '/Users/model/projects/feature/ai_home',
        updatedAt: 2000,
        startedAt: 1000,
        status: 'running'
      }
    ]
  };
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/sessions',
    url: new URL('https://node.local/v0/node-rpc/sessions?limit=1'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      getProjectsSnapshot: async () => ({ projects: [project] })
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.sessions');
  assert.equal(payload.result.sessions.length, 1);
  assert.match(payload.result.sessions[0].sessionRef, /^sess_[a-f0-9]{20}$/);
  assert.equal(payload.result.sessions[0].title, 'Remote design');
  assert.equal(payload.result.summary.total, 1);
  assert.doesNotMatch(res.body, /raw-session-id-1/);
  assert.doesNotMatch(res.body, /project-internal-id/);
  assert.doesNotMatch(res.body, /Users\/model\/projects/);
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc session catalog exposes active run attach contract with management auth', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-catalog-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-catalog',
    url: new URL('https://node.local/v0/node-rpc/session-catalog?limit=5'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      getProjectsSnapshot: async () => ({ projects: [] }),
      listNativeChatRuns: () => [{
        runId: 'run-catalog-1',
        provider: 'codex',
        accountId: '3',
        eventCursor: 3,
        startedAt: 1000,
        events: [{ cursor: 3, at: 2000, type: 'ready' }]
      }]
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_catalog');
  assert.equal(payload.result.sessions[0].sessionId, 'run-catalog-1');
  assert.equal(payload.result.sessions[0].cursor, 3);
  assert.ok(payload.result.sessions[0].allowedCommands.includes('slash'));
  assert.equal(payload.result.summary.bySource['active-run'], 1);
});

test('node rpc session attach returns active run snapshot with management auth', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-attach-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-attach',
    url: new URL('https://node.local/v0/node-rpc/session-attach'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({ sessionId: 'run-attach-1', cursor: 4 })),
      getProjectsSnapshot: async () => ({ projects: [] }),
      getNativeChatRun: (runId) => (runId === 'run-attach-1' ? { runId, provider: 'codex' } : null),
      readNativeSessionRunEvents: (query) => ({
        runId: query.runId,
        provider: 'codex',
        status: 'running',
        cursor: 8,
        events: [{ cursor: 8, type: 'assistant_text', text: 'attached' }]
      })
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_attach');
  assert.equal(payload.result.sessionId, 'run-attach-1');
  assert.equal(payload.result.cursor, 8);
  assert.equal(payload.result.snapshot.events[0].text, 'attached');
  assert.ok(payload.result.allowedCommands.includes('stop'));
});

test('node rpc session command accepts canonical message envelope with management auth', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-command-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();
  const writes = [];

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-command',
    url: new URL('https://node.local/v0/node-rpc/session-command'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        type: 'message',
        sessionId: 'run-command-1',
        commandId: 'cmd-command-1',
        idempotencyKey: 'idem-command-1',
        text: 'do not echo this'
      })),
      writeNativeSessionRunInput(payload) {
        writes.push(payload);
        return { accepted: true, runId: payload.runId };
      },
      readNativeSessionRunEvents: () => ({ cursor: 9, events: [] })
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes, [{
    runId: 'run-command-1',
    input: 'do not echo this',
    appendNewline: true
  }]);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_command');
  assert.equal(payload.result.accepted, true);
  assert.equal(payload.result.commandId, 'cmd-command-1');
  assert.equal(payload.result.idempotencyKey, 'idem-command-1');
  assert.equal(payload.result.type, 'message');
  assert.equal(payload.result.sessionId, 'run-command-1');
  assert.equal(payload.result.runId, 'run-command-1');
  assert.equal(payload.result.cursor, 9);
  assert.doesNotMatch(res.body, /do not echo this/);
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc session command rejects slash carrying approval id', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-command-invalid-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-command',
    url: new URL('https://node.local/v0/node-rpc/session-command'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        type: 'slash',
        sessionId: 'run-command-1',
        command: '/status',
        approvalId: 'codex-plan-active',
        idempotencyKey: 'idem-invalid-slash'
      }))
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'slash_command_must_not_carry_approval_id');
});

test('node rpc session ack records client cursor with management auth', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-ack-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();
  let observed = null;

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-ack',
    url: new URL('https://node.local/v0/node-rpc/session-ack'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        sessionId: 'run-ack-1',
        cursor: 12,
        consumerId: 'phone'
      })),
      ackSessionEvents(payload) {
        observed = payload;
        return {
          accepted: true,
          sessionId: payload.sessionId,
          cursor: payload.cursor,
          consumerId: payload.consumerId,
          ackedAt: 1234
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(observed, {
    sessionId: 'run-ack-1',
    cursor: 12,
    consumerId: 'phone'
  });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_ack');
  assert.equal(payload.result.cursor, 12);
  assert.equal(payload.result.consumerId, 'phone');
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc session artifact reads metadata and content with management auth', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-session-artifact-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const res = createResCapture();
  let observed = null;

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-artifact',
    url: new URL('https://node.local/v0/node-rpc/session-artifact?artifactId=art_abc123'),
    req: { headers: { authorization: 'Bearer management-secret' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      readSessionArtifact(payload) {
        observed = payload;
        return {
          artifact: {
            artifactId: payload.artifactId,
            kind: 'terminal-output',
            byteLength: 9000
          },
          content: 'AIH_ARTIFACT_CONTENT'
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(observed, { artifactId: 'art_abc123' });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'node.session_artifact');
  assert.equal(payload.result.artifact.artifactId, 'art_abc123');
  assert.equal(payload.result.content, 'AIH_ARTIFACT_CONTENT');
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc device node sessions proxies safe list through scoped device bearer', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-sessions-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  let observedInput = null;
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-sessions',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-sessions?nodeId=office-pc&limit=2&ignored=1'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          nodeId: 'office-pc',
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          transportDecision: {
            transportPurpose: 'stream',
            selectedTransportId: 'office-pc-relay',
            selectedTransportKind: 'relay',
            fallbackUsed: false,
            fallbackFrom: [],
            rejectedTransports: []
          },
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.sessions',
            result: {
              sessions: [
                {
                  sessionRef: 'sess_0123456789abcdefabcd',
                  projectRef: 'proj_0123456789abcdefabcd',
                  provider: 'codex',
                  title: 'Remote session',
                  projectName: 'AI Home',
                  status: 'running',
                  updatedAt: 2000,
                  startedAt: 1000
                }
              ],
              summary: {
                total: 1,
                returned: 1,
                byProvider: { codex: 1 },
                byStatus: { running: 1 },
                byProject: { proj_0123456789abcdefabcd: 1 },
                recentlyUpdatedAt: 2000
              }
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/sessions?limit=2');
  assert.equal(observedInput.rpc, 'control_plane.device.node_sessions');
  assert.equal(observedInput.scope, 'sessions:read');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_sessions');
  assert.equal(payload.nodeId, 'office-pc');
  assert.deepEqual(payload.transport, { id: 'office-pc-relay', kind: 'relay' });
  assert.equal(payload.transportDecision.selectedTransportKind, 'relay');
  assert.equal(payload.transportDecision.fallbackUsed, false);
  assert.equal(payload.result.sessions[0].sessionRef, 'sess_0123456789abcdefabcd');
  assert.equal(payload.result.summary.total, 1);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /relay:\/\/office-pc/);
  assert.doesNotMatch(res.body, /ignored/);
});

test('node rpc device node session catalog and attach proxy scoped contract', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-catalog-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });

  const forwarded = [];
  const transportEvidence = {
    transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
    transportDecision: {
      transportPurpose: 'stream',
      selectedTransportId: 'office-pc-relay',
      selectedTransportKind: 'relay',
      fallbackUsed: false,
      fallbackFrom: [],
      rejectedTransports: []
    }
  };
  const requestRemoteManagement = async (input) => {
    forwarded.push(input);
    if (input.pathname === '/v0/node-rpc/session-catalog?limit=3') {
      return {
        ...transportEvidence,
        status: 200,
        ok: true,
        payload: {
          ok: true,
          rpc: 'node.session_catalog',
          result: {
            sessions: [{
              sessionId: 'run-remote-1',
              runId: 'run-remote-1',
              provider: 'codex',
              status: 'running',
              cursor: 2,
              allowedCommands: ['attach', 'detach', 'message', 'slash', 'stop']
            }],
            summary: { total: 1, returned: 1 }
          }
        }
      };
    }
    if (input.pathname === '/v0/node-rpc/session-attach') {
      return {
        ...transportEvidence,
        status: 200,
        ok: true,
        payload: {
          ok: true,
          rpc: 'node.session_attach',
          result: {
            sessionId: 'run-remote-1',
            runId: 'run-remote-1',
            status: 'running',
            cursor: 5,
            snapshot: { kind: 'run-events', events: [{ cursor: 5, type: 'ready' }] },
            allowedCommands: ['attach', 'detach', 'message', 'slash', 'stop']
          }
        }
      };
    }
    return { status: 404, ok: false, payload: { ok: false, error: 'unexpected_path' } };
  };

  const catalogRes = createResCapture();
  const catalogHandled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-catalog',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-catalog?nodeId=office-pc&limit=3&ignored=1'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res: catalogRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir, requestRemoteManagement })
  });
  assert.equal(catalogHandled, true);
  assert.equal(catalogRes.statusCode, 200);
  const catalogPayload = JSON.parse(catalogRes.body);
  assert.equal(catalogPayload.rpc, 'control_plane.device.node_session_catalog');
  assert.equal(catalogPayload.nodeId, 'office-pc');
  assert.equal(catalogPayload.transport.kind, 'relay');
  assert.equal(catalogPayload.transportDecision.selectedTransportKind, 'relay');
  assert.equal(catalogPayload.result.sessions[0].sessionId, 'run-remote-1');

  const attachRes = createResCapture();
  const attachHandled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-attach',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-attach'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res: attachRes,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        sessionId: 'run-remote-1',
        cursor: 2
      }))
    })
  });
  assert.equal(attachHandled, true);
  assert.equal(attachRes.statusCode, 200);
  const attachPayload = JSON.parse(attachRes.body);
  assert.equal(attachPayload.rpc, 'control_plane.device.node_session_attach');
  assert.equal(attachPayload.nodeId, 'office-pc');
  assert.equal(attachPayload.transport.kind, 'relay');
  assert.equal(attachPayload.transportDecision.selectedTransportKind, 'relay');
  assert.equal(attachPayload.result.cursor, 5);
  assert.equal(attachPayload.result.snapshot.events[0].type, 'ready');

  assert.deepEqual(forwarded.map((item) => item.pathname), [
    '/v0/node-rpc/session-catalog?limit=3',
    '/v0/node-rpc/session-attach'
  ]);
  assert.equal(JSON.parse(forwarded[1].body).sessionId, 'run-remote-1');
  assert.doesNotMatch(catalogRes.body + attachRes.body, new RegExp(paired.token));
  assert.doesNotMatch(catalogRes.body + attachRes.body, /management-secret|ignored|relay:\/\/office-pc/);
});

test('node rpc device node session start preserves artifact threshold for remote node', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-start-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });

  let observedInput = null;
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-start',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-start'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        provider: 'codex',
        accountId: '1',
        prompt: 'say hello',
        projectPath: '/repo/project',
        model: 'gpt-5.5',
        artifactThreshold: 256,
        cols: 100,
        rows: 30,
        ignored: 'no'
      })),
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          transportDecision: {
            transportPurpose: 'stream',
            selectedTransportId: 'office-pc-relay',
            selectedTransportKind: 'relay',
            fallbackUsed: false,
            fallbackFrom: [],
            rejectedTransports: []
          },
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_start',
            result: {
              accepted: true,
              provider: 'codex',
              runId: 'run-remote-artifact',
              sessionId: 'run-remote-artifact',
              projectPath: '/repo/project',
              status: 'running'
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-start');
  assert.equal(observedInput.method, 'POST');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_start');
  assert.equal(observedInput.scope, 'sessions:write');
  assert.deepEqual(JSON.parse(observedInput.body), {
    provider: 'codex',
    accountId: '1',
    prompt: 'say hello',
    projectPath: '/repo/project',
    projectDirName: '',
    model: 'gpt-5.5',
    sessionId: '',
    artifactThreshold: 256,
    cols: 100,
    rows: 30
  });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_start');
  assert.equal(payload.nodeId, 'office-pc');
  assert.deepEqual(payload.transport, { id: 'office-pc-relay', kind: 'relay' });
  assert.equal(payload.transportDecision.transportPurpose, 'stream');
  assert.equal(payload.transportDecision.selectedTransportKind, 'relay');
  assert.equal(payload.result.runId, 'run-remote-artifact');
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret|ignored|relay:\/\/office-pc/);
});

test('node rpc device node session command proxies canonical envelope', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-command-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read', 'sessions:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });

  let observedInput = null;
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-command',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-command'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        ignored: 'no',
        type: 'slash',
        sessionId: 'run-remote-1',
        command: '/status',
        args: '--json',
        idempotencyKey: 'idem-remote-command'
      })),
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_command',
            result: {
              accepted: true,
              commandId: 'idem-remote-command',
              idempotencyKey: 'idem-remote-command',
              type: 'slash',
              sessionId: 'run-remote-1',
              runId: 'run-remote-1',
              command: '/status',
              cursor: 6
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-command');
  assert.equal(observedInput.method, 'POST');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_command');
  assert.equal(observedInput.scope, 'sessions:write');
  assert.deepEqual(JSON.parse(observedInput.body), {
    type: 'slash',
    sessionId: 'run-remote-1',
    commandId: 'idem-remote-command',
    idempotencyKey: 'idem-remote-command',
    command: '/status',
    args: '--json'
  });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_command');
  assert.equal(payload.nodeId, 'office-pc');
  assert.equal(payload.result.type, 'slash');
  assert.equal(payload.result.cursor, 6);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret|ignored|--json/);
});

test('node rpc device node session command preserves remote command error and transport evidence', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-command-error-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read', 'sessions:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['webrtc']
  }, { fs, aiHomeDir });

  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-command',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-command'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        type: 'message',
        sessionId: 'run-remote-busy',
        text: 'next',
        idempotencyKey: 'idem-remote-busy'
      })),
      requestRemoteManagement: async () => ({
        status: 409,
        ok: false,
        transport: { id: 'office-pc-webrtc', kind: 'webrtc', endpoint: 'redacted' },
        transportDecision: {
          transportPurpose: 'stream',
          selectedTransportId: 'office-pc-webrtc',
          selectedTransportKind: 'webrtc',
          fallbackUsed: false,
          fallbackFrom: [],
          rejectedTransports: []
        },
        payload: {
          ok: false,
          error: 'headless_session_run_still_running',
          message: 'headless_session_run_still_running'
        }
      })
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'headless_session_run_still_running');
  assert.equal(payload.remoteStatus, 409);
  assert.deepEqual(payload.transport, { id: 'office-pc-webrtc', kind: 'webrtc' });
  assert.equal(payload.transportDecision.selectedTransportKind, 'webrtc');
  assert.doesNotMatch(res.body, /management-secret|redacted|next/);
});

test('node rpc device node session ack proxies resume cursor', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-ack-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read', 'sessions:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });

  let observedInput = null;
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-ack',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-ack'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        sessionId: 'run-remote-1',
        cursor: 8192,
        consumerId: 'phone',
        ignored: 'no'
      })),
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_ack',
            result: {
              accepted: true,
              sessionId: 'run-remote-1',
              cursor: 8192,
              consumerId: 'phone',
              ackedAt: 1234
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-ack');
  assert.equal(observedInput.method, 'POST');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_ack');
  assert.equal(observedInput.scope, 'sessions:write');
  assert.deepEqual(JSON.parse(observedInput.body), {
    sessionId: 'run-remote-1',
    cursor: 8192,
    consumerId: 'phone'
  });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_ack');
  assert.equal(payload.nodeId, 'office-pc');
  assert.equal(payload.result.cursor, 8192);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret|ignored/);
});

test('node rpc device node session artifact proxies artifact read', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-artifact-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });

  let observedInput = null;
  const res = createResCapture();
  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-artifact',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-artifact?nodeId=office-pc&artifactId=art_remote_1&ignored=1'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_artifact',
            result: {
              artifact: {
                artifactId: 'art_remote_1',
                kind: 'terminal-output',
                byteLength: 5000
              },
              content: 'AIH_REMOTE_ARTIFACT_CONTENT'
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-artifact?artifactId=art_remote_1');
  assert.equal(observedInput.method, 'GET');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_artifact');
  assert.equal(observedInput.scope, 'sessions:read');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_artifact');
  assert.equal(payload.nodeId, 'office-pc');
  assert.equal(payload.result.artifact.artifactId, 'art_remote_1');
  assert.equal(payload.result.content, 'AIH_REMOTE_ARTIFACT_CONTENT');
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret|ignored/);
});

test('node rpc device node sessions authorizes paired tokens before checking node existence', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-sessions-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Sessions Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  let requestCalled = false;
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-sessions',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-sessions?nodeId=office-pc'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async () => {
        requestCalled = true;
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /remote_node_not_found/);
  assert.equal(requestCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device node session messages proxies safe snapshot through scoped device bearer', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-messages-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  let observedInput = null;
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-messages',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-messages?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&limit=2&ignored=1'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          nodeId: 'office-pc',
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_messages',
            result: {
              session: {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote messages',
                projectName: 'AI Home',
                status: 'running',
                updatedAt: 2000,
                startedAt: 1000
              },
              messages: [
                { role: 'user', content: 'remote question', timestamp: 1500 },
                { role: 'assistant', content: 'remote answer', timestamp: 2000 }
              ],
              summary: {
                total: 2,
                returned: 2,
                truncated: false,
                cursor: 8192
              }
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_messages');
  assert.equal(observedInput.scope, 'sessions:read');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_messages');
  assert.equal(payload.nodeId, 'office-pc');
  assert.equal(payload.result.summary.cursor, 8192);
  assert.deepEqual(payload.result.messages.map((message) => [message.role, message.content]), [
    ['user', 'remote question'],
    ['assistant', 'remote answer']
  ]);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /relay:\/\/office-pc/);
  assert.doesNotMatch(res.body, /ignored/);
});

test('node rpc device node session messages authorizes paired tokens before checking node existence', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-messages-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Sessions Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'android' }
  }, { fs, aiHomeDir });
  let requestCalled = false;
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-messages',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-messages?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async () => {
        requestCalled = true;
      }
    })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /remote_node_not_found/);
  assert.equal(requestCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device node session messages rejects nodes without sessions capability before request', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-messages-capability-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'status-only',
    name: 'Status Only',
    capabilities: ['status']
  }, { fs, aiHomeDir });
  let requestCalled = false;
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-messages',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-messages?nodeId=status-only&sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      requestRemoteManagement: async () => {
        requestCalled = true;
      }
    })
  });

  assert.equal(res.statusCode, 403);
  assert.match(res.body, /remote_node_capability_denied/);
  assert.equal(requestCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device node session input proxies typed write through scoped device bearer', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-input-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read', 'sessions:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  let observedInput = null;
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-input',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-input'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        sessionRef: 'sess_0123456789abcdefabcd',
        input: 'remote yes',
        appendNewline: true,
        promptId: 'codex-plan-active',
        ignored: 'no'
      }), 'utf8'),
      requestRemoteManagement: async (input) => {
        observedInput = input;
        return {
          nodeId: 'office-pc',
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          status: 200,
          ok: true,
          payload: {
            ok: true,
            rpc: 'node.session_input',
            result: {
              session: {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote input',
                projectName: 'AI Home',
                status: 'running',
                updatedAt: 2000,
                startedAt: 1000
              },
              accepted: true,
              appendNewline: true,
              promptId: 'codex-plan-active'
            }
          }
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-input');
  assert.equal(observedInput.method, 'POST');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_input');
  assert.equal(observedInput.scope, 'sessions:write');
  assert.deepEqual(JSON.parse(observedInput.body), {
    sessionRef: 'sess_0123456789abcdefabcd',
    input: 'remote yes',
    appendNewline: true,
    promptId: 'codex-plan-active'
  });
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.rpc, 'control_plane.device.node_session_input');
  assert.equal(payload.nodeId, 'office-pc');
  assert.equal(payload.result.accepted, true);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /relay:\/\/office-pc/);
  assert.doesNotMatch(res.body, /ignored/);
  assert.doesNotMatch(res.body, /remote yes/);
});

test('node rpc device node session input authorizes paired tokens before checking node existence', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-input-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Read Only Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'android' }
  }, { fs, aiHomeDir });
  let requestCalled = false;
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/device-node-session-input',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-input'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      body: Buffer.from(JSON.stringify({
        nodeId: 'office-pc',
        sessionRef: 'sess_0123456789abcdefabcd',
        input: 'blocked'
      }), 'utf8'),
      requestRemoteManagement: async () => {
        requestCalled = true;
      }
    })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /remote_node_not_found/);
  assert.equal(requestCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device node session stream proxies remote node stream through scoped device bearer', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-stream-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  let observedInput = null;
  const req = createReqCapture({ authorization: `Bearer ${paired.token}` });
  const res = createSseResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-stream',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750&ignored=1'),
    req,
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      streamRemoteManagement: async (input, handlers) => {
        observedInput = input;
        assert.equal(Boolean(input.signal), true);
        handlers.onOpen({ ok: true, status: 200 });
        handlers.onChunk({
          ok: true,
          rpc: 'node.session_stream',
          type: 'events',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote relay stream',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            events: [
              { type: 'assistant_text', timestamp: '2026-06-19T00:00:00.000Z', text: 'remote update' }
            ],
            cursor: 8192,
            requiresSnapshot: false,
            truncated: false
          }
        });
        return {
          nodeId: 'office-pc',
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          status: 200,
          ok: true
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(observedInput.node.id, 'office-pc');
  assert.equal(observedInput.pathname, '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750');
  assert.equal(observedInput.rpc, 'control_plane.device.node_session_stream');
  assert.equal(observedInput.scope, 'sessions:read');
  const frames = parseSseDataFrames(res.body);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rpc, 'control_plane.device.node_session_stream');
  assert.equal(frames[0].nodeId, 'office-pc');
  assert.equal(frames[0].result.cursor, 8192);
  assert.deepEqual(frames[0].result.events, [
    { type: 'assistant_text', timestamp: '2026-06-19T00:00:00.000Z', text: 'remote update' }
  ]);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret/);
  assert.doesNotMatch(res.body, /ignored/);
});

test('node rpc device node session stream resumes from latest cursor after transient remote stream failure', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-stream-resume-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'office-pc',
    name: 'Office PC',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  const observedPaths = [];
  const req = createReqCapture({ authorization: `Bearer ${paired.token}` });
  const res = createSseResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-stream',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750'),
    req,
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      deviceNodeStreamReconnects: 1,
      deviceNodeStreamReconnectDelayMs: 0,
      streamRemoteManagement: async (input, handlers) => {
        observedPaths.push(input.pathname);
        handlers.onOpen({ ok: true, status: 200 });
        if (observedPaths.length === 1) {
          handlers.onChunk({
            ok: true,
            rpc: 'node.session_stream',
            type: 'events',
            result: {
              session: {
                sessionRef: 'sess_0123456789abcdefabcd',
                projectRef: 'proj_0123456789abcdefabcd',
                provider: 'codex',
                title: 'Remote relay stream',
                projectName: 'AI Home',
                status: 'running',
                updatedAt: 2000,
                startedAt: 1000
              },
              events: [
                { type: 'assistant_text', timestamp: '2026-06-19T00:00:00.000Z', text: 'before reconnect' }
              ],
              cursor: 8192,
              requiresSnapshot: false,
              truncated: false
            }
          });
          const error = new Error('remote_relay_session_closed');
          error.code = 'remote_relay_session_closed';
          error.status = 503;
          throw error;
        }
        handlers.onChunk({
          ok: true,
          rpc: 'node.session_stream',
          type: 'events',
          result: {
            session: {
              sessionRef: 'sess_0123456789abcdefabcd',
              projectRef: 'proj_0123456789abcdefabcd',
              provider: 'codex',
              title: 'Remote relay stream',
              projectName: 'AI Home',
              status: 'running',
              updatedAt: 2000,
              startedAt: 1000
            },
            events: [
              { type: 'assistant_text', timestamp: '2026-06-19T00:00:01.000Z', text: 'after reconnect' }
            ],
            cursor: 9000,
            requiresSnapshot: false,
            truncated: false
          }
        });
        return {
          nodeId: 'office-pc',
          transport: { id: 'office-pc-relay', kind: 'relay', endpoint: 'relay://office-pc' },
          status: 200,
          ok: true
        };
      }
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(observedPaths, [
    '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096&limit=20&intervalMs=750',
    '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=8192&limit=20&intervalMs=750'
  ]);
  const frames = parseSseDataFrames(res.body);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].result.cursor, 8192);
  assert.equal(frames[1].result.cursor, 9000);
  assert.deepEqual(frames.map((frame) => frame.result.events[0].text), [
    'before reconnect',
    'after reconnect'
  ]);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
  assert.doesNotMatch(res.body, /management-secret/);
});

test('node rpc device node session stream authorizes paired tokens before checking node existence', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-stream-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Sessions Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'android' }
  }, { fs, aiHomeDir });
  let streamCalled = false;
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-stream',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=office-pc&sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      streamRemoteManagement: async () => {
        streamCalled = true;
      }
    })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /remote_node_not_found/);
  assert.equal(streamCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device node session stream rejects nodes without sessions capability before stream', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-node-session-stream-capability-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint: 'https://control.example.com',
    scopes: ['nodes:read', 'sessions:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
  upsertRemoteNode({
    id: 'status-only',
    name: 'Status Only',
    capabilities: ['status']
  }, { fs, aiHomeDir });
  let streamCalled = false;
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-node-session-stream',
    url: new URL('https://control.example.com/v0/node-rpc/device-node-session-stream?nodeId=status-only&sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({
      aiHomeDir,
      streamRemoteManagement: async () => {
        streamCalled = true;
      }
    })
  });

  assert.equal(res.statusCode, 403);
  assert.match(res.body, /remote_node_capability_denied/);
  assert.equal(streamCalled, false);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device sessions accepts any paired device token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-sessions-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Accounts Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Accounts Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-sessions',
    url: new URL('https://control.example.com/v0/node-rpc/device-sessions'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /control_plane\.device\.sessions/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device session messages authorizes paired tokens before checking session refs', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-messages-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Accounts Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Accounts Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-messages',
    url: new URL('https://control.example.com/v0/node-rpc/device-session-messages?sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /session_not_found/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device session events authorizes paired tokens before checking session refs', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-events-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Accounts Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Accounts Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-events',
    url: new URL('https://control.example.com/v0/node-rpc/device-session-events?sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /session_not_found/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device session stream authorizes paired tokens before checking session refs', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-session-stream-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Accounts Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['accounts:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Accounts Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-session-stream',
    url: new URL('https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 404);
  assert.match(res.body, /session_not_found/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc device nodes accepts any paired device token', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-nodes-scope-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createControlPlaneDeviceInvite({
    name: 'Profile Only',
    controlEndpoint: 'https://control.example.com',
    scopes: ['control-plane:read']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Profile Only', platform: 'android' }
  }, { fs, aiHomeDir });
  const res = createResCapture();

  await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/device-nodes',
    url: new URL('https://control.example.com/v0/node-rpc/device-nodes'),
    req: { headers: { authorization: `Bearer ${paired.token}` } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-secret',
    deps: createDeps({ aiHomeDir })
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /control_plane\.device\.nodes/);
  assert.doesNotMatch(res.body, new RegExp(paired.token));
});

test('node rpc rejects unauthorized requests before status generation', async () => {
  let statusGenerated = false;
  const deps = createDeps();
  deps.buildManagementStatusPayload = () => {
    statusGenerated = true;
    return {};
  };
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status',
    req: { headers: { authorization: 'Bearer wrong' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'node-secret',
    deps
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.equal(statusGenerated, false);
  assert.match(res.body, /unauthorized_node_rpc/);
});

test('node rpc join consumes invite without management bearer and registers node', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-rpc-join-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const invite = createRemoteNodeInvite({
    nodeId: 'joined-node',
    name: 'Joined Node',
    controlEndpoint: 'https://control.example.com'
  }, { fs, aiHomeDir });
  const body = Buffer.from(JSON.stringify({
    node: {
      endpoint: 'http://100.64.0.20:9527',
      managementKey: 'joined-secret',
      transportKind: 'tailscale'
    }
  }), 'utf8');
  const res = createResCapture();

  const handled = await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/join',
    url: new URL(`https://control.example.com/v0/node-rpc/join?code=${encodeURIComponent(invite.code)}`),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'management-not-needed-for-join',
    deps: createDeps({ aiHomeDir, body })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.node.id, 'joined-node');
  assert.equal(payload.node.transports[0].kind, 'tailscale');
  assert.doesNotMatch(res.body, /joined-secret/);
  assert.equal(getRemoteNode('joined-node', { fs, aiHomeDir }).name, 'Joined Node');
  assert.equal(readRemoteSecret('remote-node/joined-node', { fs, aiHomeDir }).managementKey, 'joined-secret');

  const secondRes = createResCapture();
  await handleNodeRpcRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/join',
    url: new URL(`https://control.example.com/v0/node-rpc/join?code=${encodeURIComponent(invite.code)}`),
    req: { headers: {} },
    res: secondRes,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: createDeps({ aiHomeDir, body })
  });
  assert.equal(secondRes.statusCode, 410);
  assert.match(secondRes.body, /invite_already_consumed/);
});
