'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  TRANSPORT_CONFIG_KEY,
  applyTransportConfigDefaults,
  formatFabricTransportConfigReport,
  runFabricTransportConfigCommand,
  writeTransportConfig
} = require('../lib/cli/services/fabric/transport-config');
const {
  runFabricTransportPrerequisitesCommand
} = require('../lib/cli/services/fabric/transport-prerequisites');
const {
  runFabricTransportPromotionGateCommand
} = require('../lib/cli/services/fabric/transport-promotion-gate');

function createStoreDeps(initial = null) {
  const store = new Map();
  if (initial) store.set(TRANSPORT_CONFIG_KEY, initial);
  return {
    aiHomeDir: '/tmp/aih-fabric-transport-config',
    env: {},
    readJsonValue: (_fs, _aiHomeDir, key) => store.get(key) || null,
    writeJsonValue: (_fs, _aiHomeDir, key, value) => store.set(key, value),
    readStoredConfig: () => store.get(TRANSPORT_CONFIG_KEY) || null
  };
}

test('fabric transport config set/show/clear redacts TURN credential', async () => {
  const deps = createStoreDeps();

  const setReport = await runFabricTransportConfigCommand([
    'set',
    '--turn-ice-server',
    'turn:turn.example.com:3478?transport=udp',
    '--turn-username',
    'user',
    '--turn-credential',
    'secret',
    '--webtransport-url',
    'https://wt.example.com/fabric',
    '--webtransport-page-url',
    'https://wt.example.com/probe',
    '--json'
  ], deps);

  assert.equal(setReport.ok, true);
  assert.equal(setReport.json, true);
  assert.equal(setReport.config.turn.configured, true);
  assert.equal(setReport.config.turn.credentialPresent, true);
  assert.equal(JSON.stringify(setReport).includes('secret'), false);
  assert.equal(deps.readStoredConfig().turn.credential, 'secret');

  const text = formatFabricTransportConfigReport(setReport);
  assert.match(text, /credential: <redacted>/);
  assert.equal(text.includes('secret'), false);

  const clearReport = await runFabricTransportConfigCommand(['clear', '--turn'], deps);
  assert.equal(clearReport.config.turn.configured, false);
  assert.equal(clearReport.config.webtransport.configured, true);
});

test('transport config defaults feed prerequisites without overriding explicit flags', async () => {
  const deps = createStoreDeps();
  writeTransportConfig({
    turn: {
      iceServers: ['turn:configured.example.com:3478'],
      username: 'configured-user',
      credential: 'configured-secret'
    },
    webtransport: {
      url: 'https://configured.example.com/wt',
      pageUrl: 'https://configured.example.com/probe'
    }
  }, {}, deps);

  const report = await runFabricTransportPrerequisitesCommand([
    '--turn-ice-server',
    'turn:cli.example.com:3478',
    '--json'
  ], {
    ...deps,
    runPrerequisiteAudit: async (options) => {
      assert.deepEqual(options.turnIceServers, ['turn:cli.example.com:3478']);
      assert.equal(options.turnUsername, 'configured-user');
      assert.equal(options.turnCredential, 'configured-secret');
      assert.equal(options.webTransportUrl, 'https://configured.example.com/wt');
      return {
        ok: true,
        summary: { promotionReady: false }
      };
    }
  });

  assert.deepEqual(report.transportConfig.applied.sort(), [
    'turn.credential',
    'turn.username',
    'webtransport.pageUrl',
    'webtransport.url'
  ].sort());
  assert.equal(JSON.stringify(report).includes('configured-secret'), false);
});

test('transport config defaults feed promotion gate WebTransport options', async () => {
  const deps = createStoreDeps();
  writeTransportConfig({
    webtransport: {
      url: 'https://configured.example.com/wt',
      pageUrl: 'https://configured.example.com/probe'
    }
  }, {}, deps);

  const report = await runFabricTransportPromotionGateCommand(['--json'], {
    ...deps,
    runPromotionGate: async (options) => {
      assert.equal(options.webTransportUrl, 'https://configured.example.com/wt');
      assert.equal(options.webTransportPageUrl, 'https://configured.example.com/probe');
      return {
        ok: true,
        summary: { promotionReady: false }
      };
    }
  });

  assert.deepEqual(report.transportConfig.applied.sort(), [
    'webtransport.pageUrl',
    'webtransport.url'
  ].sort());
});

test('fabric command router routes transport config JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'config',
    'show',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricTransportConfigCommand: async (args) => {
      assert.deepEqual(args, ['show', '--json']);
      return {
        ok: true,
        json: true,
        action: 'show',
        config: {
          turn: { configured: false, credentialPresent: false, iceServers: [] },
          webtransport: { configured: false, url: '', pageUrl: '' }
        }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.config.turn.configured, false);
});

test('applyTransportConfigDefaults keeps environment values ahead of stored values', () => {
  const deps = createStoreDeps({
    version: 1,
    turn: {
      iceServers: ['turn:configured.example.com:3478'],
      username: 'configured-user',
      credential: 'configured-secret',
      updatedAt: 1
    },
    webtransport: {
      url: 'https://configured.example.com/wt',
      pageUrl: '',
      updatedAt: 1
    },
    updatedAt: 1
  });

  const merged = applyTransportConfigDefaults({
    turnIceServers: ['turn:env.example.com:3478']
  }, [], {
    ...deps,
    env: {
      AIH_TURN_ICE_SERVER: 'turn:env.example.com:3478'
    }
  });

  assert.deepEqual(merged.options.turnIceServers, ['turn:env.example.com:3478']);
  assert.equal(merged.options.turnUsername, 'configured-user');
});
