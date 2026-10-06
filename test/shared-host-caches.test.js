'use strict';

// 账号投影里的宿主共享缓存（provider-storage-policy.js 的 sharedHostCaches）：
// 每个账号不再各自下载一套工具链 / 应用更新包，投影里只有指向宿主真实路径的链接。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getProviderSharedHostCaches } = require('../lib/runtime/provider-storage-policy');
const { isSharedHostCacheSegments, linkSharedHostCaches } = require('../lib/runtime/shared-host-caches');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shared-host-caches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'host');
  const projectionRoot = path.join(root, 'projection');
  fs.mkdirSync(hostHomeDir);
  fs.mkdirSync(projectionRoot);
  const link = (provider = 'zcode') => linkSharedHostCaches({ fs, path, provider, projectionRoot, hostHomeDir, platform: 'darwin' });
  return { hostHomeDir, projectionRoot, link };
}

test('a per-account copy is discarded when the host already has the cache, never merged', (t) => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.hostHomeDir, 'go', 'pkg', 'mod'), { recursive: true });
  const copy = path.join(f.projectionRoot, 'go', 'pkg', 'mod', 'account-download.zip');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, 'PER-ACCOUNT');

  const first = f.link();

  assert.deepEqual(first.replaced, ['go']);
  assert.deepEqual(first.failed, []);
  assert.equal(fs.lstatSync(path.join(f.projectionRoot, 'go')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(f.projectionRoot, 'go')), fs.realpathSync(path.join(f.hostHomeDir, 'go')));
  assert.equal(fs.existsSync(path.join(f.hostHomeDir, 'go', 'pkg', 'mod', 'account-download.zip')), false);

  const second = f.link();
  assert.deepEqual([second.linked, second.replaced, second.adopted, second.failed], [[], [], [], []], 'idempotent');
});

test('a cache the host does not have yet is moved to the host instead of re-downloaded', (t) => {
  const f = setup(t);
  const copy = path.join(f.projectionRoot, '.bun', 'install', 'cache', 'pkg.tgz');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, 'DOWNLOADED-ONCE');

  const result = f.link();

  assert.deepEqual(result.adopted, ['.bun']);
  assert.equal(fs.readFileSync(path.join(f.hostHomeDir, '.bun', 'install', 'cache', 'pkg.tgz'), 'utf8'), 'DOWNLOADED-ONCE');
  assert.equal(fs.lstatSync(path.join(f.projectionRoot, '.bun')).isSymbolicLink(), true);
});

test('nothing is created on the host when neither side has the cache', (t) => {
  const f = setup(t);
  const result = f.link();
  assert.deepEqual([result.linked, result.replaced, result.adopted, result.failed], [[], [], [], []]);
  assert.deepEqual(fs.readdirSync(f.hostHomeDir), [], 'no empty directories on the host');
  assert.deepEqual(fs.readdirSync(f.projectionRoot), []);
});

test('a link pointing elsewhere is re-pointed at the host path', (t) => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.hostHomeDir, '.npm'));
  const elsewhere = path.join(f.hostHomeDir, 'unrelated');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.projectionRoot, '.npm'));

  const result = f.link();

  assert.ok(result.linked.includes('.npm'));
  assert.equal(fs.realpathSync(path.join(f.projectionRoot, '.npm')), fs.realpathSync(path.join(f.hostHomeDir, '.npm')));
  assert.equal(fs.existsSync(elsewhere), true);
});

test('removing an account projection never deletes through a cache link', (t) => {
  // account-removal / runtime-projection-pruner / transient-auth-projection 都用
  // fs.rmSync(dir, { recursive: true, force: true }) 删除整个投影。
  const f = setup(t);
  const sentinels = getProviderSharedHostCaches('workbuddy', 'darwin').map((entry) => {
    const file = path.join(f.hostHomeDir, ...entry.host, 'HOST-SENTINEL');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'host data');
    return file;
  });
  const linked = f.link('workbuddy');
  assert.equal(linked.linked.length, sentinels.length);

  fs.rmSync(f.projectionRoot, { recursive: true, force: true });

  assert.equal(fs.existsSync(f.projectionRoot), false);
  for (const file of sentinels) assert.equal(fs.readFileSync(file, 'utf8'), 'host data', file);
});

test('credential-bearing parents are never linked, only their declared leaves', () => {
  for (const provider of ['zcode', 'kimi', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const entry of getProviderSharedHostCaches(provider, platform)) {
        const joined = entry.projection.join('/');
        assert.notEqual(joined, '.local', `${provider}: .local holds opencode auth; link .local/bin only`);
        assert.ok(!joined.startsWith('Library/Application Support'), `${provider}: ${joined}`);
        assert.ok(!joined.startsWith('electron-user-data'), `${provider}: ${joined}`);
        assert.ok(!['.workbuddy-ai', '.workbuddy', '.codebuddy', '.zcode', '.kimi-code'].includes(joined), `${provider}: ${joined}`);
      }
    }
  }
});

test('platform-specific caches apply only on their platform', () => {
  const darwin = getProviderSharedHostCaches('zcode', 'darwin').map((entry) => entry.projection.join('/'));
  const win32 = getProviderSharedHostCaches('zcode', 'win32').map((entry) => entry.projection.join('/'));
  assert.ok(darwin.includes('Library/Caches/go-build'));
  assert.ok(!win32.some((value) => value.startsWith('Library/')));
  assert.equal(isSharedHostCacheSegments('zcode', ['Library', 'Caches', 'go-build', 'ab'], 'darwin'), true);
  assert.equal(isSharedHostCacheSegments('zcode', ['Library', 'Caches', 'other'], 'darwin'), false);
  assert.deepEqual(getProviderSharedHostCaches('codex', 'darwin'), []);
});
