'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseChecksum,
  prepareGoCore,
  releaseAssetName,
  resolveDownloadUrls
} = require('../scripts/postinstall-go-core');
const { sha256Hex, verifyBuildStamp } = require('../lib/cli/services/server/go-core-build-stamp');

const silentLog = { log() {} };

function fixtureRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-postinstall-go-'));
  fs.mkdirSync(path.join(root, 'contracts', 'route-ownership'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contracts', 'route-ownership', 'manifest.json'), '{"entries":[]}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const noGo = () => ({ status: 1 });

test('release asset naming and URLs follow the npm version', () => {
  assert.equal(releaseAssetName('darwin', 'arm64'), 'aih-server-darwin-arm64');
  assert.equal(releaseAssetName('win32', 'x64'), 'aih-server-win32-x64.exe');
  assert.deepEqual(resolveDownloadUrls({ downloadBase: 'https://example.test/dl/', platform: 'linux', arch: 'x64', version: '1.2.3' }), {
    binary: 'https://example.test/dl/v1.2.3/aih-server-linux-x64',
    checksum: 'https://example.test/dl/v1.2.3/aih-server-linux-x64.sha256'
  });
  assert.equal(parseChecksum(`${'a'.repeat(64)}  aih-server-linux-x64\n`), 'a'.repeat(64));
  assert.equal(parseChecksum('not-a-hash'), '');
});

test('without a Go toolchain the prebuilt binary is downloaded, verified and stamped', async (t) => {
  const repositoryRoot = fixtureRepository(t);
  const bytes = Buffer.from('prebuilt-go-core');
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('.sha256')) return { ok: true, text: async () => `${sha256Hex(bytes)}  asset\n` };
    return { ok: true, arrayBuffer: async () => bytes };
  };

  const result = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: noGo, fetchImpl, log: silentLog });

  assert.equal(result.action, 'downloaded');
  assert.equal(requested[0], 'https://github.com/madou1217/ai_home/releases/download/v9.9.9/aih-server-linux-x64.sha256');
  assert.deepEqual(fs.readFileSync(result.binaryPath), bytes);
  assert.equal(verifyBuildStamp(fs, { binaryPath: result.binaryPath, expectedVersion: '9.9.9' }).ok, true);

  const again = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: noGo, fetchImpl: async () => { throw new Error('should not download'); }, log: silentLog });
  assert.equal(again.action, 'up_to_date');
});

test('a checksum mismatch never writes the binary', async (t) => {
  const repositoryRoot = fixtureRepository(t);
  const fetchImpl = async (url) => (url.endsWith('.sha256')
    ? { ok: true, text: async () => 'b'.repeat(64) }
    : { ok: true, arrayBuffer: async () => Buffer.from('tampered') });

  const result = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: noGo, fetchImpl, log: silentLog });

  assert.deepEqual(result, { action: 'unavailable', reason: 'sha256 mismatch' });
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'bin', 'native', 'linux-x64', 'aih-server')), false);
});

test('a missing release or a network error leaves installation successful', async (t) => {
  const repositoryRoot = fixtureRepository(t);
  const missing = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: noGo, fetchImpl: async () => ({ ok: false, status: 404 }), log: silentLog });
  assert.equal(missing.action, 'unavailable');
  const offline = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: noGo, fetchImpl: async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); }, log: silentLog });
  assert.deepEqual(offline, { action: 'unavailable', reason: 'ENOTFOUND' });
  const skipped = await prepareGoCore({ repositoryRoot, env: { AIH_SKIP_GO_CORE_INSTALL: '1' }, log: silentLog });
  assert.equal(skipped.action, 'skipped');
});

test('a local Go toolchain builds instead of downloading', async (t) => {
  const repositoryRoot = fixtureRepository(t);
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...(args || [])].join(' '));
    return { status: 0 };
  };
  const result = await prepareGoCore({ repositoryRoot, platform: 'linux', arch: 'x64', env: {}, spawnSync: spawnSyncImpl, fetchImpl: async () => { throw new Error('should not download'); }, log: silentLog });
  assert.equal(result.action, 'built');
  assert.equal(calls[0], 'go version');
  assert.match(calls[1], /scripts\/build-go-server\.js$/);
});
