'use strict';

// 桌面 family 的整目录缓存共享：Library/Caches 下的条目逐项链到宿主，
// 唯一例外是应用自己的 Chromium 缓存（<bundleId>，可能带凭据）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { linkSharedHostCaches, isSharedHostCacheSegments } = require('../lib/runtime/shared-host-caches');

function withRoots(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shared-caches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectionRoot = path.join(root, 'projection');
  const hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(projectionRoot, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  return { root, projectionRoot, hostHomeDir };
}

function writeDir(root, ...segments) {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker'), 'x');
  return dir;
}

test('Library/Caches 整目录逐项共享，账号态条目留在投影里', (t) => {
  const { projectionRoot, hostHomeDir } = withRoots(t);
  writeDir(projectionRoot, 'Library', 'Caches', 'Homebrew');
  writeDir(projectionRoot, 'Library', 'Caches', 'go-build');
  const accountCache = writeDir(projectionRoot, 'Library', 'Caches', 'dev.zcode.app');
  writeDir(hostHomeDir, 'Library', 'Caches', 'Homebrew');
  writeDir(hostHomeDir, 'Library', 'Caches', '.npm');

  const result = linkSharedHostCaches({
    fs, path, platform: 'darwin', provider: 'zcode', projectionRoot, hostHomeDir
  });

  const cachesDir = path.join(projectionRoot, 'Library', 'Caches');
  assert.equal(fs.lstatSync(path.join(cachesDir, 'Homebrew')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(cachesDir, 'Homebrew')), fs.realpathSync(path.join(hostHomeDir, 'Library', 'Caches', 'Homebrew')));
  // 宿主没有、投影有的条目：整体移给宿主再建链（省掉重新下载）
  assert.equal(fs.lstatSync(path.join(cachesDir, 'go-build')).isSymbolicLink(), true);
  assert.equal(result.adopted.some((item) => item.endsWith(path.join('Library', 'Caches', 'go-build'))), true);
  // 宿主独有条目也会被链进来
  assert.equal(fs.lstatSync(path.join(cachesDir, '.npm')).isSymbolicLink(), true);
  // 账号自己的应用缓存：保持真实目录，不共享
  assert.equal(fs.lstatSync(accountCache).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(accountCache, 'marker')), true);
});

test('非桌面 family 不受整目录规则影响', (t) => {
  const { projectionRoot, hostHomeDir } = withRoots(t);
  writeDir(projectionRoot, 'Library', 'Caches', 'pip');
  writeDir(hostHomeDir, 'Library', 'Caches', 'pip');
  linkSharedHostCaches({ fs, path, platform: 'darwin', provider: 'kiro', projectionRoot, hostHomeDir });
  // kiro 没有声明整目录规则：pip 既不是它的白名单条目，也不该被父目录规则带走。
  assert.equal(fs.lstatSync(path.join(projectionRoot, 'Library', 'Caches', 'pip')).isSymbolicLink(), false);
});

test('isSharedHostCacheSegments 认可整目录的子项，但排除账号态条目', () => {
  assert.equal(isSharedHostCacheSegments('zcode', ['Library', 'Caches', 'pip'], 'darwin'), true);
  assert.equal(isSharedHostCacheSegments('zcode', ['Library', 'Caches', 'dev.zcode.app'], 'darwin'), false);
  assert.equal(isSharedHostCacheSegments('zcode', ['Library', 'Caches', 'dev.zcode.app', 'Cache'], 'darwin'), false);
  assert.equal(isSharedHostCacheSegments('kiro', ['Library', 'Caches', 'pip'], 'darwin'), false);
});
