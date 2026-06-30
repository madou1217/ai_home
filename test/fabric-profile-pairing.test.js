'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  formatFabricProfilePairingReport,
  parseArgs,
  parseControlPlanePairInput,
  runFabricProfilePairingCommand
} = require('../lib/cli/services/fabric/profile-pairing');
const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  listControlPlaneProfiles
} = require('../lib/server/control-plane-profile-store');

function createAiHome(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-profile-pairing-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    });
    req.on('error', reject);
  });
}

async function startPairingServer(t) {
  const requests = [];
  let endpoint = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, endpoint);
    const body = req.method === 'POST' ? await readBody(req) : {};
    requests.push({
      method: req.method,
      pathname: url.pathname,
      body
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/v0/webui/control-plane/devices/invites') {
      res.end(JSON.stringify({
        ok: true,
        code: 'pair-code-real',
        pairUrl: `${endpoint}/v0/fabric/device-pair?code=pair-code-real`,
        invite: { id: 'device-invite-real' },
        warnings: []
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v0/fabric/device-pair') {
      res.end(JSON.stringify({
        ok: true,
        rpc: 'fabric.device.pair',
        result: {
          device: {
            id: body.device && body.device.id,
            name: body.device && body.device.name,
            platform: body.device && body.device.platform,
            state: 'paired'
          },
          token: 'raw-device-token-secret'
        }
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v0/fabric/descriptor') {
      res.end(JSON.stringify({
        ok: true,
        rpc: 'fabric.descriptor.read',
        result: {
          ok: true,
          service: 'aih-fabric',
          protocolVersion: 1,
          server: {
            id: 'fabric-test',
            name: 'Fabric Test Server',
            endpoint
          },
          roles: ['server', 'relay'],
          auth: { methods: ['device-pair'] },
          capabilities: { client: ['server-profile', 'device-pairing'] }
        }
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      endpoint = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  t.after(() => server.close());
  return {
    endpoint,
    requests
  };
}

test('fabric profile pairing parser keeps pair URL endpoint and code', () => {
  const parsed = parseControlPlanePairInput(
    'https://control.example.com/base/v0/fabric/device-pair?code=pair-code'
  );

  assert.equal(parsed.endpoint, 'https://control.example.com/base');
  assert.equal(parsed.code, 'pair-code');
});

test('fabric profile pairing parser defaults pair-self endpoint to loopback', () => {
  const options = parseArgs(['--json'], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example',
    HOSTNAME: 'aws-current'
  });

  assert.equal(options.json, true);
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.match(options.deviceId, /^aih-cli-/);
});

test('fabric profile pair-self creates real invite, consumes device pair, and saves ready profile', async (t) => {
  const aiHomeDir = createAiHome(t);
  const server = await startPairingServer(t);

  const report = await runFabricProfilePairingCommand('pair-self', [
    '--endpoint',
    server.endpoint,
    '--ai-home-dir',
    aiHomeDir,
    '--device-id',
    'aws-self-cli',
    '--device-name',
    'AWS Self CLI',
    '--platform',
    'linux',
    '--json'
  ]);

  assert.equal(report.ok, true);
  assert.equal(report.action, 'pair-self');
  assert.equal(report.endpoint, server.endpoint);
  assert.equal(report.profile.authState, 'paired');
  assert.equal(report.deviceTokenPresent, true);
  assert.deepEqual(server.requests.map((request) => `${request.method} ${request.pathname}`), [
    'POST /v0/webui/control-plane/devices/invites',
    'POST /v0/fabric/device-pair',
    'GET /v0/fabric/descriptor'
  ]);
  assert.equal(server.requests[0].body.controlEndpoint, server.endpoint);
  assert.equal(server.requests[1].body.code, 'pair-code-real');
  assert.equal(server.requests[1].body.device.id, 'aws-self-cli');

  const store = listControlPlaneProfiles({ fs, aiHomeDir });
  assert.equal(store.profiles.length, 1);
  assert.equal(store.activeProfileId, report.profile.id);
  assert.equal(store.profiles[0].endpoint, server.endpoint);
  assert.equal(store.profiles[0].state, 'paired');
  assert.equal(store.profiles[0].authState, 'paired');
  assert.equal(store.profiles[0].deviceToken, 'raw-device-token-secret');

  const printable = formatFabricProfilePairingReport(report);
  assert.doesNotMatch(printable, /raw-device-token-secret/);
  assert.doesNotMatch(JSON.stringify(report), /raw-device-token-secret/);
  assert.doesNotMatch(JSON.stringify(report), /pair-code-real/);
});

test('fabric profile pair consumes existing code and stores profile without creating invite', async (t) => {
  const aiHomeDir = createAiHome(t);
  const server = await startPairingServer(t);

  const report = await runFabricProfilePairingCommand('pair', [
    '--endpoint',
    server.endpoint,
    '--code',
    'manual-code-real',
    '--ai-home-dir',
    aiHomeDir,
    '--device-id',
    'manual-cli',
    '--json'
  ]);

  assert.equal(report.ok, true);
  assert.deepEqual(server.requests.map((request) => `${request.method} ${request.pathname}`), [
    'POST /v0/fabric/device-pair',
    'GET /v0/fabric/descriptor'
  ]);
  assert.equal(server.requests[0].body.code, 'manual-code-real');
  assert.equal(listControlPlaneProfiles({ fs, aiHomeDir }).profiles[0].authState, 'paired');
});

test('fabric command router routes profile pair-self JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'profile',
    'pair-self',
    '--endpoint',
    'http://127.0.0.1:9527',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value, callback) => {
        writes.push(String(value));
        if (callback) callback();
      } },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricProfilePairingCommand: async (action, args) => {
      assert.equal(action, 'pair-self');
      assert.deepEqual(args, ['--endpoint', 'http://127.0.0.1:9527', '--json']);
      return {
        ok: true,
        json: true,
        action,
        endpoint: 'http://127.0.0.1:9527',
        profile: { id: 'cp-loopback', authState: 'paired' },
        deviceTokenPresent: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.action, 'pair-self');
  assert.equal(payload.deviceTokenPresent, true);
});
