'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startServerSourceAutoRestart,
  extractServeArgsFromArgv,
  stripSensitiveServeArgs
} = require('../lib/server/source-auto-restart');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-source-auto-restart-'));
}

function makeSourceCheckout(root) {
  const repoDir = path.join(root, 'source-ai-home');
  const entryFilePath = path.join(repoDir, 'lib', 'cli', 'app.js');
  fs.mkdirSync(path.dirname(entryFilePath), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'lib', 'server'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'ai_home' }), 'utf8');
  fs.writeFileSync(entryFilePath, "'use strict';\nmodule.exports = {};\n", 'utf8');
  fs.writeFileSync(path.join(repoDir, 'lib', 'server', 'v1-router.js'), "'use strict';\n", 'utf8');
  return { repoDir, entryFilePath };
}

test('extractServeArgsFromArgv preserves original server serve flags', () => {
  assert.deepEqual(
    extractServeArgsFromArgv(['/node', '/repo/lib/cli/app.js', 'server', 'serve', '--host', '0.0.0.0', '--port', '8317']),
    ['--host', '0.0.0.0', '--port', '8317']
  );
  assert.deepEqual(extractServeArgsFromArgv(['/node', '/repo/lib/cli/app.js', 'server', 'restart']), []);
});

test('stripSensitiveServeArgs removes secret-bearing server flags', () => {
  assert.deepEqual(stripSensitiveServeArgs([
    '--host',
    '0.0.0.0',
    '--api-key',
    'client-secret',
    '--management-key=management-secret',
    '--client-key',
    'legacy-secret',
    '--port',
    '9527'
  ]), [
    '--host',
    '0.0.0.0',
    '--port',
    '9527'
  ]);
});

test('source auto restart records fingerprint and restarts on source change', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const source = makeSourceCheckout(root);
  const spawnCalls = [];
  const controller = startServerSourceAutoRestart({}, {
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 98765, unref() {} };
    },
    processObj: {
      pid: 12345,
      execPath: '/usr/local/bin/node',
      env: { AIH_SERVER_SOURCE_AUTO_RESTART: '0' },
      argv: [
        '/usr/local/bin/node',
        source.entryFilePath,
        'server',
        'serve',
        '--host',
        '0.0.0.0',
        '--port',
        '8317'
      ]
    },
    aiHomeDir,
    entryFilePath: source.entryFilePath,
    nodeExecPath: '/usr/local/bin/node'
  });

  const fingerprintFile = path.join(aiHomeDir, 'server.source-fingerprint.json');
  assert.equal(fs.existsSync(fingerprintFile), true);
  const recorded = JSON.parse(fs.readFileSync(fingerprintFile, 'utf8'));
  assert.equal(recorded.pid, 12345);
  assert.equal(recorded.entryFilePath, source.entryFilePath);

  fs.appendFileSync(path.join(source.repoDir, 'lib', 'server', 'v1-router.js'), 'module.exports = {};\n');
  const result = controller.checkOnce();
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'source_changed');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, '/usr/local/bin/node');
  assert.deepEqual(spawnCalls[0].args, [
    source.entryFilePath,
    'server',
    'restart',
    '--host',
    '0.0.0.0',
    '--port',
    '8317'
  ]);
  assert.equal(spawnCalls[0].opts.detached, true);

  controller.checkOnce();
  assert.equal(spawnCalls.length, 1);
  controller.stop();
});

test('source auto restart preserves proxy and model probe options when replaying argv serve args', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const source = makeSourceCheckout(root);
  const spawnCalls = [];
  const controller = startServerSourceAutoRestart({
    proxyUrl: 'http://127.0.0.1:6152',
    noProxy: 'localhost,127.0.0.1',
    modelsProbeAccounts: 8,
    apiKey: 'client-secret',
    managementKey: 'management-secret'
  }, {
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 98765, unref() {} };
    },
    processObj: {
      pid: 12345,
      execPath: '/usr/local/bin/node',
      env: { AIH_SERVER_SOURCE_AUTO_RESTART: '0' },
      argv: [
        '/usr/local/bin/node',
        source.entryFilePath,
        'server',
        'serve',
        '--host',
        '127.0.0.1',
        '--port',
        '9527',
        '--api-key',
        'old-client-secret',
        '--management-key=old-management-secret'
      ]
    },
    aiHomeDir,
    entryFilePath: source.entryFilePath,
    nodeExecPath: '/usr/local/bin/node'
  });

  fs.appendFileSync(path.join(source.repoDir, 'lib', 'server', 'v1-router.js'), 'module.exports = {};\n');
  controller.checkOnce();
  assert.deepEqual(spawnCalls[0].args, [
    source.entryFilePath,
    'server',
    'restart',
    '--host',
    '127.0.0.1',
    '--port',
    '9527',
    '--proxy-url',
    'http://127.0.0.1:6152',
    '--no-proxy',
    'localhost,127.0.0.1',
    '--models-probe-accounts',
    '8'
  ]);
  assert.equal(spawnCalls[0].args.includes('client-secret'), false);
  assert.equal(spawnCalls[0].args.includes('management-secret'), false);
  assert.equal(spawnCalls[0].args.includes('old-client-secret'), false);
  assert.equal(spawnCalls[0].args.some((arg) => String(arg).includes('old-management-secret')), false);
  controller.stop();
});
