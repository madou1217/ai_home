const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function createSourceLinkHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-update-source-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source-ai-home');
  const packageJsonPath = path.join(sourceRoot, 'package.json');
  const sourceEntryFilePath = path.join(sourceRoot, 'bin', 'ai-home.js');
  const linkedEntryFilePath = path.join(root, 'homebrew', 'bin', 'aih');
  fs.mkdirSync(path.join(sourceRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(sourceEntryFilePath), { recursive: true });
  fs.mkdirSync(path.dirname(linkedEntryFilePath), { recursive: true });
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'ai_home', version: '1.0.0' }), 'utf8');
  fs.writeFileSync(sourceEntryFilePath, '#!/usr/bin/env node\n', 'utf8');
  fs.symlinkSync(sourceEntryFilePath, linkedEntryFilePath);

  const logs = [];
  const errors = [];
  const spawnCalls = [];
  let fetchCalls = 0;
  const service = createSelfUpdateService({
    fs,
    path,
    packageJsonPath,
    cliEntryFilePath: linkedEntryFilePath,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('npm registry must not be queried for source-link installs');
    },
    spawnSyncImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (command === 'git' && args.includes('rev-parse')) {
        return { status: 0, stdout: 'abc123def456\n', stderr: '' };
      }
      return { status: 9, stdout: '', stderr: 'unexpected command' };
    },
    processObj: {
      env: {},
      argv: ['/usr/local/bin/node', linkedEntryFilePath],
      execPath: '/usr/local/bin/node',
      platform: 'darwin'
    },
    log: (message) => logs.push(String(message)),
    error: (message) => errors.push(String(message))
  });

  return {
    service,
    sourceRoot,
    sourceEntryFilePath,
    linkedEntryFilePath,
    logs,
    errors,
    spawnCalls,
    getFetchCalls: () => fetchCalls
  };
}

function assertNoSourceLinkMutation(h) {
  assert.equal(h.getFetchCalls(), 0);
  assert.equal(h.spawnCalls.some((call) => call.command === 'npm'), false);
  assert.equal(h.spawnCalls.some((call) => call.command === 'git' && call.args.includes('pull')), false);
}

test('self update check reports source-link metadata without querying npm registry', async (t) => {
  const h = createSourceLinkHarness(t);

  const code = await h.service.runUpdateCommand(['--check']);

  assert.equal(code, 0);
  assertNoSourceLinkMutation(h);
  assert.equal(h.logs.some((line) => line.includes('source: source-link')), true);
  assert.equal(h.logs.some((line) => line.includes(h.sourceRoot)), true);
  assert.equal(h.logs.some((line) => line.includes('abc123def456')), true);
});

test('self update refuses npm mutation for source-link installs and prints a manual update hint', async (t) => {
  const h = createSourceLinkHarness(t);

  const code = await h.service.runUpdateCommand(['--force']);

  assert.equal(code, 1);
  assertNoSourceLinkMutation(h);
  assert.equal(h.errors.some((line) => line.includes('Automatic update skipped')), true);
  assert.equal(h.logs.some((line) => line.includes('git -C') && line.includes('pull --ff-only')), true);
  assert.equal(h.logs.some((line) => line.includes('aih server restart')), true);
  assert.equal(fs.realpathSync(h.linkedEntryFilePath), fs.realpathSync(h.sourceEntryFilePath));
});

test('self update bare command fails closed with source-link manual update guidance', async (t) => {
  const h = createSourceLinkHarness(t);

  const code = await h.service.runUpdateCommand([]);

  assert.equal(code, 1);
  assertNoSourceLinkMutation(h);
  assert.equal(h.errors.some((line) => line.includes('Automatic update skipped')), true);
  assert.equal(h.logs.some((line) => line.includes('git -C') && line.includes('pull --ff-only')), true);
  assert.equal(h.logs.some((line) => line.includes('aih server restart')), true);
});

test('self update dry-run does not render an npm command for source-link installs', async (t) => {
  const h = createSourceLinkHarness(t);

  const code = await h.service.runUpdateCommand(['--dry-run']);

  assert.equal(code, 1);
  assertNoSourceLinkMutation(h);
  assert.equal(h.logs.some((line) => line.includes('dry-run: npm')), false);
  assert.equal(h.logs.some((line) => line.includes('pull --ff-only')), true);
});

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

test('self update service migrates installed macOS background jobs through the updated CLI', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-update-background-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const launchAgentsDir = path.join(hostHomeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(launchAgentsDir, 'com.clawdcodex.ai_home.node-relay.local.plist'),
    'legacy relay service'
  );

  const logs = [];
  const errors = [];
  const spawnCalls = [];
  const cliEntryFilePath = '/usr/local/lib/node_modules/ai_home/bin/ai-home.js';
  const service = createSelfUpdateService({
    fs,
    path,
    hostHomeDir,
    cliEntryFilePath,
    packageInfo: { name: 'ai_home', version: '1.0.0' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.0' })
    }),
    spawnSyncImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
    processObj: {
      env: { HOME: hostHomeDir },
      argv: ['/usr/local/bin/node', cliEntryFilePath],
      execPath: '/usr/local/bin/node',
      platform: 'darwin'
    },
    log: (message) => logs.push(String(message)),
    error: (message) => errors.push(String(message))
  });

  const code = await service.runUpdateCommand([]);

  assert.equal(code, 0);
  assert.deepEqual(spawnCalls.map(({ command, args }) => ({ command, args })), [
    {
      command: 'npm',
      args: ['install', '-g', 'ai_home@latest']
    },
    {
      command: '/usr/local/bin/node',
      args: [cliEntryFilePath, 'server', 'autostart', 'install']
    }
  ]);
  assert.equal(spawnCalls[1].options.shell, false);
  assert.equal(logs.some((line) => line.includes('migrating installed macOS background services')), true);
  assert.deepEqual(errors, []);
});

test('self update reports an actionable error when macOS background migration fails', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-update-background-failure-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const launchAgentsDir = path.join(hostHomeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(launchAgentsDir, 'com.clawdcodex.ai_home.plist'), 'server service');

  const errors = [];
  let spawnCount = 0;
  const service = createSelfUpdateService({
    fs,
    path,
    hostHomeDir,
    cliEntryFilePath: '/usr/local/lib/node_modules/ai_home/bin/ai-home.js',
    packageInfo: { name: 'ai_home', version: '1.0.0' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.0' })
    }),
    spawnSyncImpl: () => {
      spawnCount += 1;
      return { status: spawnCount === 1 ? 0 : 9 };
    },
    processObj: {
      env: { HOME: hostHomeDir },
      argv: ['/usr/local/bin/node', '/usr/local/lib/node_modules/ai_home/bin/ai-home.js'],
      execPath: '/usr/local/bin/node',
      platform: 'darwin'
    },
    log: () => {},
    error: (message) => errors.push(String(message))
  });

  const code = await service.runUpdateCommand([]);

  assert.equal(code, 9);
  assert.equal(errors.some((line) => line.includes('aih server autostart install')), true);
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
