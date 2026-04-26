const test = require('node:test');
const assert = require('node:assert/strict');

const { createSelfUpdateService } = require('../lib/cli/services/update/self-update');

function createServiceHarness(overrides = {}) {
  const logs = [];
  const errors = [];
  const spawnCalls = [];

  const packageInfo = {
    name: 'ai_home',
    version: '1.0.0'
  };

  const service = createSelfUpdateService({
    packageInfo,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.0' })
    }),
    spawnSyncImpl: (command, args) => {
      spawnCalls.push({ command, args });
      return { status: 0 };
    },
    processObj: {
      env: {},
      argv: ['/usr/local/bin/node', '/usr/local/lib/node_modules/ai_home/bin/ai-home.js'],
      platform: 'darwin'
    },
    log: (msg) => logs.push(String(msg)),
    error: (msg) => errors.push(String(msg))
  });

  return {
    service,
    logs,
    errors,
    spawnCalls,
    ...overrides
  };
}

test('self update service check mode reports current and latest versions without install', async () => {
  const h = createServiceHarness();
  const code = await h.service.runUpdateCommand(['--check']);
  assert.equal(code, 0);
  assert.deepEqual(h.spawnCalls, []);
  assert.equal(h.logs.some((line) => line.includes('current: 1.0.0')), true);
  assert.equal(h.logs.some((line) => line.includes('latest: 1.1.0')), true);
});

test('self update service runs npm global install when npm source is detected', async () => {
  const h = createServiceHarness();
  const code = await h.service.runUpdateCommand([]);
  assert.equal(code, 0);
  assert.deepEqual(h.spawnCalls, [{
    command: 'npm',
    args: ['install', '-g', 'ai_home@latest']
  }]);
});

test('self update service prints manual command when install source is unknown', async () => {
  const h = createServiceHarness();
  const service = createSelfUpdateService({
    packageInfo: { name: 'ai_home', version: '1.0.0' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.0' })
    }),
    spawnSyncImpl: () => ({ status: 0 }),
    processObj: {
      env: {},
      argv: ['/usr/local/bin/node', '/custom/bin/aih'],
      platform: 'darwin'
    },
    log: (msg) => h.logs.push(String(msg)),
    error: (msg) => h.errors.push(String(msg))
  });
  const code = await service.runUpdateCommand([]);
  assert.equal(code, 1);
  assert.equal(h.errors.some((line) => line.includes('Unable to determine a safe auto-update source')), true);
  assert.equal(h.logs.some((line) => line.includes('npm install -g ai_home@latest')), true);
});
