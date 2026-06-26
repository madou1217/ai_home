const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { getRemoteAuditLogPath } = require('../lib/server/remote/audit-log');
const { getRemoteInvitesPath } = require('../lib/server/remote/pairing');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createDeps(aiHomeDir, fetchImpl, body = null) {
  return {
    fs,
    aiHomeDir,
    fetchImpl,
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
    checkStatus() { return {}; }
  };
}

function readAuditEvents(aiHomeDir) {
  const filePath = getRemoteAuditLogPath(aiHomeDir);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('web ui remote node routes save nodes, hide secrets and test management status', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-nodes-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const savePayload = Buffer.from(JSON.stringify({
    id: 'office-pc',
    name: 'Office PC',
    endpoint: 'https://office.example.com',
    managementKey: 'remote-secret',
    preferredTransports: ['direct']
  }), 'utf8');

  const saveRes = createResCapture();
  const saveHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: saveRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, savePayload)
  });

  assert.equal(saveHandled, true);
  assert.equal(saveRes.statusCode, 200);
  const saved = JSON.parse(saveRes.body);
  assert.equal(saved.node.id, 'office-pc');
  assert.equal(saved.node.transports[0].endpoint, 'https://office.example.com');
  assert.doesNotMatch(saveRes.body, /remote-secret/);

  const listRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: listRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir)
  });
  assert.equal(listRes.statusCode, 200);
  assert.doesNotMatch(listRes.body, /remote-secret/);

  let observedUrl = '';
  let observedAuth = '';
  const testRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/office-pc/test',
    url: new URL('http://localhost/v0/webui/nodes/office-pc/test'),
    req: { headers: {} },
    res: testRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, async (url, init) => {
      observedUrl = String(url);
      observedAuth = String(init && init.headers && init.headers.authorization || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          service: 'aih-server',
          nodeDiagnostics: {
            service: { state: 'running', running: true }
          }
        })
      };
    })
  });

  assert.equal(testRes.statusCode, 200);
  const observed = new URL(observedUrl);
  assert.equal(`${observed.origin}${observed.pathname}`, 'https://office.example.com/v0/node-rpc/status');
  assert.equal(observed.searchParams.get('diagnostics'), '1');
  assert.equal(observed.searchParams.get('controlUrl'), 'http://localhost');
  assert.equal(observed.searchParams.get('nodeId'), 'office-pc');
  assert.equal(observedAuth, 'Bearer remote-secret');
  const tested = JSON.parse(testRes.body);
  assert.equal(tested.result.payload.service, 'aih-server');
  assert.equal(tested.result.payload.nodeDiagnostics.service.state, 'running');
});

test('web ui remote node defaults use local machine identity and relay provider', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-node-defaults-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const defaultsRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/nodes/defaults',
    url: new URL('http://localhost/v0/webui/nodes/defaults'),
    req: { headers: {} },
    res: defaultsRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir),
      hostname: () => 'Dev MacBook Pro',
      platform: 'darwin',
      arch: 'arm64',
      gitRemoteUrl: 'git@github.com:madou1217/ai_home.git',
      homeDir: '/Users/model',
      cwd: '/Users/model/projects/feature/ai_home'
    }
  });

  assert.equal(defaultsRes.statusCode, 200);
  const payload = JSON.parse(defaultsRes.body);
  assert.equal(payload.defaults.name, 'Dev MacBook Pro');
  assert.match(payload.defaults.nodeId, /^dev-macbook-pro-[a-f0-9]{8}$/);
  assert.equal(payload.defaults.transportKind, 'relay');
  assert.equal(payload.defaults.provider, 'aih-relay');
  assert.equal(payload.defaults.trustLevel, 'managed');
  assert.equal(payload.defaults.transportDefaults.relay.provider, 'aih-relay');
  assert.equal(payload.defaults.transportDefaults.relay.trustLevel, 'managed');
  assert.equal(payload.defaults.transportDefaults.omr.routeRole, 'underlay');
  assert.equal(payload.defaults.transportCatalog.relay.lane, 'data-plane');
  assert.equal(payload.defaults.transportCatalog.relay.endpointMode, 'relay');
  assert.match(payload.defaults.transportCatalog.relay.summary, /AIH-managed default no-public-IP data-plane/);
  assert.equal(payload.defaults.transportCatalog.omr.lane, 'underlay');
  assert.match(payload.defaults.transportCatalog.omr.summary, /Underlay only/);
  assert.match(payload.defaults.transportCatalog.mptcp.summary, /Underlay only/);
  assert.match(payload.defaults.transportCatalog.ssh.summary, /parallel bootstrap\/probe channel/);
  assert.equal(payload.defaults.transportStrategies[0].id, 'no-public-ip-default');
  assert.deepEqual(payload.defaults.transportStrategies[0].dataPlaneTransports, ['relay']);
  assert.deepEqual(payload.defaults.transportStrategies[0].bootstrapTransports, ['ssh']);
  assert.equal(
    payload.defaults.transportStrategies.some((strategy) => (
      strategy.id === 'underlay-optimization'
        && strategy.underlayTransports.includes('omr')
        && strategy.underlayTransports.includes('mptcp')
        && strategy.dataPlaneTransports.length === 0
    )),
    true
  );
  assert.equal(payload.defaults.repoUrl, 'https://github.com/madou1217/ai_home.git');
  assert.equal(payload.defaults.repoSubdir, 'projects/feature/ai_home');
});

test('web ui remote node routes save relay nodes without public endpoint', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-node-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saveRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: saveRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      id: 'nat-node',
      name: 'NAT Node'
    }), 'utf8'))
  });

  assert.equal(saveRes.statusCode, 200);
  const saved = JSON.parse(saveRes.body);
  assert.equal(saved.node.id, 'nat-node');
  assert.equal(saved.node.transports[0].id, 'nat-node-relay');
  assert.equal(saved.node.transports[0].kind, 'relay');
  assert.equal(saved.node.transports[0].endpoint, 'relay://nat-node');
  assert.equal(saved.node.transports[0].provider, 'aih-relay');
  assert.equal(saved.node.connection.status, 'offline');
  assert.equal(saved.node.connection.transportKind, 'relay');
  assert.equal(saved.node.connection.transportId, 'nat-node-relay');
});

test('web ui remote node routes save uses local defaults when identity is omitted', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-node-save-defaults-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saveRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: saveRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
        transportKind: 'relay'
      }), 'utf8')),
      hostname: () => 'Dev MacBook Pro',
      platform: 'darwin',
      arch: 'arm64'
    }
  });

  assert.equal(saveRes.statusCode, 200);
  const saved = JSON.parse(saveRes.body);
  assert.equal(saved.node.name, 'Dev MacBook Pro');
  assert.match(saved.node.id, /^dev-macbook-pro-[a-f0-9]{8}$/);
  assert.deepEqual(saved.node.preferredTransports, ['relay']);
  assert.equal(saved.node.transports[0].kind, 'relay');
  assert.equal(saved.node.transports[0].endpoint, `relay://${saved.node.id}`);
  assert.equal(saved.node.transports[0].provider, 'aih-relay');
  assert.equal(saved.node.transports[0].routeRole, 'data-plane');
  assert.equal(saved.node.transports[0].trustLevel, 'managed');
});

test('web ui remote node routes preserve top-level transport when node payload is nested', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-node-nested-transport-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const saveRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: saveRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      node: {
        id: 'nested-node',
        name: 'Nested Node'
      },
      transportKind: 'frp',
      endpoint: 'https://frp.example.com/nested-node'
    }), 'utf8'))
  });

  assert.equal(saveRes.statusCode, 200);
  const saved = JSON.parse(saveRes.body);
  assert.equal(saved.node.id, 'nested-node');
  assert.equal(saved.node.name, 'Nested Node');
  assert.deepEqual(saved.node.preferredTransports, ['frp']);
  assert.equal(saved.node.transports[0].kind, 'frp');
  assert.equal(saved.node.transports[0].endpoint, 'https://frp.example.com/nested-node');
  assert.equal(saved.node.transports[0].provider, 'frp');
});

test('web ui remote node routes create invite without exposing stored code hash', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      nodeId: 'phone-target',
      name: 'Phone Target',
      preferredTransports: ['frp', 'direct'],
      capabilities: ['status', 'accounts']
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.ok, true);
  assert.equal(created.invite.nodeId, 'phone-target');
  assert.match(created.joinUrl, /^https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=/);
  assert.ok(created.code);
  assert.equal(created.invite.codeHash, undefined);
  assert.doesNotMatch(fs.readFileSync(getRemoteInvitesPath(aiHomeDir), 'utf8'), new RegExp(created.code));

  const listRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: { headers: {} },
    res: listRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir)
  });

  assert.equal(listRes.statusCode, 200);
  assert.doesNotMatch(listRes.body, /codeHash/);
  assert.doesNotMatch(listRes.body, new RegExp(created.code));
});

test('web ui remote node invite derives provider from transport kind', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-provider-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      nodeId: 'nat-node',
      transportKind: 'relay'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.invite.transportKind, 'relay');
  assert.equal(created.invite.provider, 'aih-relay');
  assert.equal(created.invite.trustLevel, 'managed');
  assert.match(created.joinCommand, /'--transport' 'relay'/);
  assert.doesNotMatch(created.joinCommand, /--endpoint/);
});

test('web ui remote node invite warns when control endpoint is loopback', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-loopback-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://127.0.0.1:9527/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: '127.0.0.1:9527'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      controlEndpoint: 'http://127.0.0.1:9527',
      transportKind: 'relay',
      bootstrapTarget: 'linux',
      repoUrl: 'https://example.com/ai_home.git'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.warnings.some((warning) => warning.includes('远端机器会把它当成自己本机')), true);
  assert.equal(created.bootstrap.plan.warnings.some((warning) => warning.includes('control-url points to loopback')), true);
  assert.match(created.joinUrl, /^http:\/\/127\.0\.0\.1:9527\/v0\/node-rpc\/join\?code=/);
});

test('web ui remote node invite defaults underlay role for OpenMPTCPRouter', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-underlay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      transportKind: 'omr'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.invite.provider, 'openmptcprouter');
  assert.equal(created.invite.routeRole, 'underlay');
  assert.equal(created.invite.trustLevel, 'external');
  assert.match(created.joinCommand, /'--transport' 'omr'/);
});

test('web ui remote node invite can leave identity for target-side defaults', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-target-defaults-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      transportKind: 'relay'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.invite.nodeId, '');
  assert.equal(created.invite.name, '');
  assert.match(created.joinUrl, /^https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=/);
});

test('web ui remote node invite returns bootstrap script without secret material', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-bootstrap-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      transportKind: 'frp',
      endpointHint: 'https://frp.example.com/node-a',
      bootstrapTarget: 'linux',
      repoUrl: 'https://example.com/ai_home.git',
      repoDir: '/opt/ai_home',
      managementKey: 'must-not-leak',
      deviceToken: 'device-token-must-not-leak'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.bootstrap.plan.target, 'linux');
  assert.equal(created.bootstrap.plan.transportKind, 'frp');
  assert.equal(created.bootstrap.plan.security.containsSecrets, false);
  assert.deepEqual(created.bootstrap.plan.requiredInputs, []);
  assert.match(created.joinCommand, /'--transport' 'frp'/);
  assert.match(created.joinCommand, /'--endpoint' 'https:\/\/frp\.example\.com\/node-a'/);
  assert.match(created.probeCommand, /aih node bootstrap probe/);
  assert.match(created.probeCommand, /--ssh user@linux-host --ssh user@mac-host --tcp windows-host/);
  assert.match(created.probeCommand, /--invite-url 'https:\/\/control\.example\.com\/v0\/node-rpc\/join\?code=/);
  assert.match(created.probeCommand, /--repo-url https:\/\/example\.com\/ai_home\.git --repo-dir \/opt\/ai_home/);
  assert.match(created.probeCommand, /--transport frp --endpoint https:\/\/frp\.example\.com\/node-a/);
  assert.match(created.bootstrap.script.content, /'aih' 'node' 'join'/);
  assert.match(created.bootstrap.script.content, new RegExp(created.joinUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(created.bootstrap.script.content, /'--endpoint' 'https:\/\/frp\.example\.com\/node-a'/);
  assert.match(created.bootstrap.script.content, /AIH_REPO_DIR=\$\{AIH_REPO_DIR:-'\/opt\/ai_home'\}/);
  assert.doesNotMatch(createRes.body, /must-not-leak|device-token-must-not-leak|codeHash/);
  assert.doesNotMatch(fs.readFileSync(getRemoteInvitesPath(aiHomeDir), 'utf8'), /must-not-leak|device-token-must-not-leak/);
});

test('web ui remote node bootstrap plan previews Windows local console bootstrap without storing invite', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-plan-win-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const planRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-plan',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-plan'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: planRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      bootstrapTarget: 'win32',
      transportKind: 'relay',
      repoUrl: 'https://example.com/ai_home.git',
      managementKey: 'must-not-leak'
    }), 'utf8'))
  });

  assert.equal(planRes.statusCode, 200);
  const payload = JSON.parse(planRes.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.plan.target, 'win32');
  assert.equal(payload.plan.channel, 'local-manual');
  assert.equal(payload.plan.transportKind, 'relay');
  assert.equal(payload.plan.script.type, 'powershell');
  assert.equal(payload.plan.requiredInputs.includes('invite-url'), true);
  assert.equal(payload.plan.prerequisites.some((item) => item.includes('local console')), true);
  assert.match(payload.plan.steps.find((step) => step.id === 'open-bootstrap-channel').command, /PowerShell script/);
  assert.match(payload.script.content, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.doesNotMatch(planRes.body, /must-not-leak|codeHash|managementKey/);
  assert.equal(fs.existsSync(getRemoteInvitesPath(aiHomeDir)), false);
});

test('web ui remote node bootstrap plan keeps external underlay endpoint requirements server-side', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-plan-omr-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const planRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-plan',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-plan'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: planRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      bootstrapTarget: 'linux',
      transportKind: 'omr',
      endpointHint: 'https://omr.example.com/node-a',
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
      repoUrl: 'https://example.com/ai_home.git'
    }), 'utf8'))
  });

  assert.equal(planRes.statusCode, 200);
  const payload = JSON.parse(planRes.body);
  assert.equal(payload.plan.target, 'linux');
  assert.equal(payload.plan.channel, 'ssh');
  assert.equal(payload.plan.transportKind, 'omr');
  assert.equal(payload.plan.requiredInputs.includes('endpoint'), false);
  assert.equal(payload.plan.transportGuidance.some((item) => item.includes('OpenMPTCPRouter')), true);
  assert.equal(payload.plan.transportGuidance.some((item) => item.includes('underlay route provider')), true);
  assert.equal(payload.plan.warnings.some((warning) => warning.includes('does not install FRP/VPN/OMR/MPTCP/SSH tooling')), true);
  assert.match(payload.script.content, /'--transport' 'omr' '--endpoint' 'https:\/\/omr\.example\.com\/node-a'/);
  assert.equal(fs.existsSync(getRemoteInvitesPath(aiHomeDir)), false);
});

test('web ui remote node invite uses explicit probe targets when provided', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-probe-targets-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      transportKind: 'relay',
      bootstrapTarget: 'linux',
      repoUrl: 'https://example.com/ai_home.git',
      repoSubdir: 'projects/feature/ai_home',
      probeSshTargets: 'model@192.168.3.8\\nmodel@192.168.3.22\\nmodel@192.168.3.8',
      probeTcpTargets: '192.168.3.76'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.match(created.probeCommand, /aih node bootstrap probe/);
  assert.match(created.probeCommand, /--ssh model@192\.168\.3\.8 --ssh model@192\.168\.3\.22 --tcp 192\.168\.3\.76/);
  assert.doesNotMatch(created.probeCommand, /user@linux-host|user@mac-host|windows-host/);
  assert.match(created.probeCommand, /--repo-subdir projects\/feature\/ai_home/);
  assert.match(created.probeCommand, /--ports 22,445,3389,5985,5986/);
});

test('web ui remote node invite rejects invalid bootstrap target before storing invite', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-invite-bootstrap-target-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const createRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/invites',
    url: new URL('http://localhost/v0/webui/nodes/invites'),
    req: {
      headers: {
        host: 'control.example.com',
        'x-forwarded-proto': 'https'
      }
    },
    res: createRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      transportKind: 'relay',
      bootstrapTarget: 'android'
    }), 'utf8'))
  });

  assert.equal(createRes.statusCode, 400);
  assert.match(createRes.body, /unsupported_bootstrap_target/);
  assert.deepEqual(fs.existsSync(getRemoteInvitesPath(aiHomeDir))
    ? JSON.parse(fs.readFileSync(getRemoteInvitesPath(aiHomeDir), 'utf8')).invites
    : [], []);
});

test('web ui remote node bootstrap probe runs readonly ssh and tcp diagnostics', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-probe-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const probeRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-probe',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-probe'),
    req: { headers: {} },
    res: probeRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
        probeSshTargets: ['model@linux.local'],
        probeTcpTargets: ['win.local'],
        probeTcpPorts: [22, 3389, 445, 5985],
        controlEndpoint: 'https://control.example.com',
        inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
        repoUrl: 'https://example.com/ai_home.git',
        repoSubdir: 'projects/feature/ai_home',
        repoDir: '/opt/ai_home',
        bootstrapTarget: 'win32',
        transportKind: 'relay',
        concurrency: 2,
        executeConcurrency: 3,
        executeTimeoutMs: 600000,
        timeoutMs: 750
      }), 'utf8')),
      sshProbe: async () => ({
        status: 'reachable',
        platform: 'Linux',
        arch: 'x86_64',
        commands: { node: false, npm: false, git: true, aih: false },
        repo: { present: false }
      }),
      tcpProbe: async (target) => ({
        ports: target.ports.map((port) => ({
          port,
          open: port === 3389 || port === 445,
          error: port === 3389 || port === 445 ? '' : 'ECONNREFUSED'
        }))
      })
    }
  });

  assert.equal(probeRes.statusCode, 200);
  const payload = JSON.parse(probeRes.body);
  assert.equal(payload.ok, true);
  assert.match(payload.command, /^aih node bootstrap probe --ssh model@linux\.local --tcp win\.local/);
  assert.match(payload.command, /--ports 22,445,3389,5985/);
  assert.match(payload.command, /--target win32/);
  assert.match(payload.command, /--repo-subdir projects\/feature\/ai_home/);
  assert.match(payload.command, /--timeout-ms 750$/);
  assert.match(payload.applyCommand, /^aih node bootstrap apply --ssh model@linux\.local --tcp win\.local/);
  assert.match(payload.applyCommand, /--target win32/);
  assert.match(payload.applyExecuteCommand, /^aih node bootstrap apply --execute --yes --execute-concurrency 3 --execute-timeout-ms 600000 --ssh model@linux\.local --tcp win\.local/);
  assert.match(payload.applyExecuteCommand, /--target win32/);
  assert.equal(payload.apply.mode, 'dry-run');
  assert.equal(payload.apply.executeConcurrency, 3);
  assert.equal(payload.apply.executeTimeoutMs, 600000);
  assert.equal(payload.apply.plan.summary.executable, 1);
  assert.equal(payload.apply.plan.summary.dryRun, 1);
  assert.equal(payload.apply.plan.summary.manual, 1);
  assert.match(payload.apply.plan.actions[0].command, /ssh model@linux\.local 'sh -s'/);
  assert.equal(payload.apply.plan.actions[1].executionState, 'manual');
  assert.equal(payload.report.summary.reachableSsh, 1);
  assert.equal(payload.report.summary.localManual, 1);
  assert.deepEqual(payload.report.executionPlan.map((step) => ({
    order: step.order,
    status: step.status,
    channel: step.channel,
    target: step.target
  })), [
    { order: 1, status: 'ready', channel: 'ssh', target: 'model@linux.local' },
    { order: 2, status: 'manual', channel: 'local-manual', target: 'win.local' }
  ]);
  assert.match(payload.report.executionPlan[0].command, /ssh model@linux\.local 'sh -s'/);
  assert.match(payload.report.executionPlan[1].command, /aih node bootstrap --target win32 --script-only/);
  assert.equal(payload.report.results[0].bootstrapAction.channel, 'ssh');
  assert.match(payload.report.results[0].bootstrapAction.remoteRunCommand, /ssh model@linux\.local 'sh -s'/);
  assert.equal(payload.report.results[0].bootstrapScript.target, 'linux');
  assert.equal(payload.report.results[0].bootstrapScript.type, 'sh');
  assert.equal(payload.report.results[0].bootstrapScript.requiredInputs.length, 0);
  assert.match(payload.report.results[0].bootstrapScript.content, /git clone/);
  assert.match(payload.report.results[0].bootstrapScript.content, /npm install/);
  assert.match(payload.report.results[0].bootstrapScript.content, /'aih' 'node' 'join'/);
  assert.doesNotMatch(payload.report.results[0].bootstrapScript.content, /nodePairToken|remote-secret/i);
  assert.equal(payload.report.results[1].accessMode, 'local-manual');
  assert.deepEqual(payload.report.results[1].openPorts, [445, 3389]);
  assert.match(payload.report.results[1].bootstrapAction.targetAction, /PowerShell script/);
  assert.match(payload.report.results[1].bootstrapAction.note, /Local manual bootstrap only/);
  assert.equal(payload.report.results[1].bootstrapScript.target, 'win32');
  assert.equal(payload.report.results[1].bootstrapScript.type, 'powershell');
  assert.equal(payload.report.results[1].bootstrapScript.requiredInputs.length, 0);
  assert.match(payload.report.results[1].bootstrapScript.content, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.match(payload.report.results[1].bootstrapScript.content, /& 'aih' 'node' 'join'/);
  assert.doesNotMatch(payload.report.results[1].bootstrapScript.content, /nodePairToken|remote-secret/i);
});

test('web ui remote node bootstrap apply requires explicit confirmation', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-apply-confirm-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const applyRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-apply',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-apply'),
    req: { headers: {} },
    res: applyRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      execute: true,
      probeSshTargets: ['model@linux.local'],
      inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc'
    }), 'utf8'))
  });

  assert.equal(applyRes.statusCode, 409);
  const payload = JSON.parse(applyRes.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'bootstrap_apply_confirmation_required');
});

test('web ui remote node bootstrap apply reports missing execute inputs', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-apply-inputs-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const applyRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-apply',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-apply'),
    req: { headers: {} },
    res: applyRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
        execute: true,
        confirm: 'execute',
        probeSshTargets: ['model@linux.local'],
        inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
        transportKind: 'relay'
      }), 'utf8')),
      sshProbe: async () => {
        throw new Error('probe should not run when execute inputs are incomplete');
      }
    }
  });

  assert.equal(applyRes.statusCode, 400);
  const payload = JSON.parse(applyRes.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'bootstrap_apply_required_inputs_missing');
  assert.deepEqual(payload.requiredInputs, ['control-url', 'repo-url']);
  assert.match(payload.message, /control-url, repo-url/);
});

test('web ui remote node bootstrap apply executes ssh-ready targets with structured runner', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-apply-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const calls = [];
  const applyRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-apply',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-apply'),
    req: { headers: {} },
    res: applyRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
        execute: true,
        confirm: 'execute',
        probeSshTargets: ['model@linux.local', 'model@mac.local'],
        controlEndpoint: 'https://control.example.com',
        inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
        repoUrl: 'https://example.com/ai_home.git',
        repoSubdir: 'projects/feature/ai_home',
        transportKind: 'relay',
        executeConcurrency: 2,
        executeTimeoutMs: 600000
      }), 'utf8')),
      sshProbe: async (target) => ({
        status: 'reachable',
        platform: target.host.includes('mac') ? 'Darwin' : 'Linux',
        arch: target.host.includes('mac') ? 'arm64' : 'x86_64',
        commands: { node: true, npm: true, git: true, aih: true },
        repo: { present: true }
      }),
      commandRunner: async (command, options) => {
        calls.push({ command, target: options.target });
        return {
          status: options.target.includes('mac') ? 1 : 0,
          stdout: options.target.includes('mac') ? '' : 'joined linux',
          stderr: options.target.includes('mac') ? 'mac failed' : '',
          timedOut: false
        };
      }
    }
  });

  assert.equal(applyRes.statusCode, 200);
  const payload = JSON.parse(applyRes.body);
  assert.equal(payload.ok, false);
  assert.match(payload.command, /^aih node bootstrap apply --execute --yes --execute-concurrency 2 --execute-timeout-ms 600000/);
  assert.equal(payload.apply.mode, 'execute');
  assert.equal(payload.apply.executeConcurrency, 2);
  assert.equal(payload.apply.executeTimeoutMs, 600000);
  assert.equal(payload.apply.plan.summary.executable, 2);
  assert.equal(payload.apply.plan.summary.executed, 1);
  assert.equal(payload.apply.plan.summary.failed, 1);
  assert.deepEqual(calls.map((call) => call.target).sort(), ['model@linux.local', 'model@mac.local']);
  assert.equal(payload.apply.plan.actions[0].executionState, 'executed');
  assert.equal(payload.apply.plan.actions[0].stdout, 'joined linux');
  assert.equal(payload.apply.plan.actions[1].executionState, 'failed');
  assert.equal(payload.apply.plan.actions[1].stderr, 'mac failed');
  assert.equal(payload.report.executionPlan.length, 2);
  assert.match(payload.report.results[0].bootstrapScript.content, /\$HOME\/projects\/feature\/ai_home/);
});

test('web ui remote node bootstrap apply reports no executable ssh actions', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-apply-noop-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const calls = [];
  const applyRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-apply',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-apply'),
    req: { headers: {} },
    res: applyRes,
    options: {},
    state: {},
    deps: {
      ...createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
        execute: true,
        confirm: 'execute',
        probeTcpTargets: ['win.local'],
        probeTcpPorts: [3389, 445],
        controlEndpoint: 'https://control.example.com',
        inviteUrl: 'https://control.example.com/v0/node-rpc/join?code=abc',
        repoUrl: 'https://example.com/ai_home.git',
        repoSubdir: 'projects/feature/ai_home',
        transportKind: 'relay'
      }), 'utf8')),
      tcpProbe: async (target) => ({
        ports: target.ports.map((port) => ({ port, open: port === 3389 || port === 445 }))
      }),
      commandRunner: async (command) => {
        calls.push(command);
        return { status: 0, stdout: '', stderr: '', timedOut: false };
      }
    }
  });

  assert.equal(applyRes.statusCode, 200);
  const payload = JSON.parse(applyRes.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.apply.ok, false);
  assert.equal(payload.apply.plan.error, 'bootstrap_apply_no_executable_actions');
  assert.equal(payload.apply.plan.summary.executable, 0);
  assert.equal(payload.apply.plan.summary.manual, 1);
  assert.equal(payload.apply.plan.summary.executed, 0);
  assert.equal(calls.length, 0);
  assert.match(payload.apply.plan.warnings.join('\n'), /No SSH-ready bootstrap actions/);
});

test('web ui remote node bootstrap probe rejects empty target lists', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-bootstrap-probe-empty-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const probeRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/bootstrap-probe',
    url: new URL('http://localhost/v0/webui/nodes/bootstrap-probe'),
    req: { headers: {} },
    res: probeRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, Buffer.from(JSON.stringify({
      probeSshTargets: [],
      probeTcpTargets: []
    }), 'utf8'))
  });

  assert.equal(probeRes.statusCode, 400);
  assert.match(probeRes.body, /missing_probe_targets/);
});

test('web ui remote management routes forward allowlisted reads with query and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-management-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const savePayload = Buffer.from(JSON.stringify({
    id: 'lab-node',
    name: 'Lab Node',
    endpoint: 'http://127.0.0.1:19527',
    managementKey: 'lab-secret',
    preferredTransports: ['direct']
  }), 'utf8');

  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: createResCapture(),
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, savePayload)
  });

  const calls = [];
  const usageRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/nodes/lab-node/management/usage/stats',
    url: new URL('http://localhost/v0/webui/nodes/lab-node/management/usage/stats?from=2026-06-01&to=2026-06-02&provider=codex'),
    req: { headers: {} },
    res: usageRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, async (url, init) => {
      calls.push({
        url: String(url),
        method: init && init.method,
        auth: init && init.headers && init.headers.authorization
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, totals: [] })
      };
    })
  });

  assert.equal(usageRes.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19527/v0/management/usage/stats?from=2026-06-01&to=2026-06-02&provider=codex');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].auth, 'Bearer lab-secret');

  const blockedRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes/lab-node/management/restart',
    url: new URL('http://localhost/v0/webui/nodes/lab-node/management/restart'),
    req: { headers: {} },
    res: blockedRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, async () => {
      throw new Error('unexpected_fetch');
    })
  });
  assert.equal(blockedRes.statusCode, 404);
  assert.match(blockedRes.body, /remote_management_route_not_allowed/);

  const events = readAuditEvents(aiHomeDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].nodeId, 'lab-node');
  assert.equal(events[0].rpc, 'usage.stats');
  assert.equal(events[0].scope, 'usage:read');
  assert.equal(events[0].pathname, '/v0/management/usage/stats?from=2026-06-01&to=2026-06-02&provider=codex');
  assert.equal(events[0].transportKind, 'direct');
  assert.equal(events[0].status, 200);
  assert.equal(events[0].ok, true);
  assert.doesNotMatch(fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8'), /lab-secret/);
});

test('web ui remote management routes reject missing node capabilities before fetch', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-remote-capability-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const savePayload = Buffer.from(JSON.stringify({
    id: 'status-only',
    name: 'Status Only',
    endpoint: 'https://status.example.com',
    capabilities: ['status'],
    preferredTransports: ['direct']
  }), 'utf8');

  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/nodes',
    url: new URL('http://localhost/v0/webui/nodes'),
    req: { headers: {} },
    res: createResCapture(),
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, null, savePayload)
  });

  let fetchCalled = false;
  const metricsRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/nodes/status-only/management/metrics',
    url: new URL('http://localhost/v0/webui/nodes/status-only/management/metrics'),
    req: { headers: {} },
    res: metricsRes,
    options: {},
    state: {},
    deps: createDeps(aiHomeDir, async () => {
      fetchCalled = true;
      return {
        ok: true,
        status: 200,
        text: async () => '{}'
      };
    })
  });

  assert.equal(metricsRes.statusCode, 403);
  assert.match(metricsRes.body, /remote_node_capability_denied/);
  assert.equal(fetchCalled, false);
  assert.deepEqual(readAuditEvents(aiHomeDir), []);
});
