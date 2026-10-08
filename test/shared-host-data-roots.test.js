'use strict';

// 桌面 App 数据根整体链接到宿主：会话与数据库只有宿主一份，真实数据既不丢也不自动合并。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { linkSharedHostDataRoots } = require('../lib/runtime/shared-host-data-roots');
const { linkSharedHostCaches } = require('../lib/runtime/shared-host-caches');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-data-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'host');
  const projectionRoot = path.join(root, 'account');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(projectionRoot, { recursive: true });
  const link = () => linkSharedHostDataRoots({ provider: 'workbuddycn', projectionRoot, hostHomeDir, platform: 'darwin' });
  return { hostHomeDir, projectionRoot, link };
}

test('a missing or empty account data root becomes a link to the host data root', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.hostHomeDir, '.workbuddy'));
  fs.writeFileSync(path.join(f.hostHomeDir, '.workbuddy', 'workbuddy.db'), 'host-sessions');
  fs.mkdirSync(path.join(f.projectionRoot, 'WorkBuddy'));
  fs.mkdirSync(path.join(f.hostHomeDir, 'WorkBuddy'));

  const result = f.link();

  assert.deepEqual(result.linked.sort(), ['.workbuddy', 'WorkBuddy']);
  assert.deepEqual(result.unresolved, []);
  assert.equal(fs.readFileSync(path.join(f.projectionRoot, '.workbuddy', 'workbuddy.db'), 'utf8'), 'host-sessions');
  assert.equal(fs.lstatSync(path.join(f.projectionRoot, '.workbuddy')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(f.hostHomeDir, '.sheetagent')), false, 'no empty host directories are invented');
  assert.deepEqual(f.link().unchanged.sort(), ['.workbuddy', 'WorkBuddy'], 'linking is idempotent');
});

test('account data the host does not have yet is moved to the host instead of copied', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.projectionRoot, '.sheetagent', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(f.projectionRoot, '.sheetagent', 'logs', 'mcp.log'), 'account-log');

  const result = f.link();

  assert.deepEqual(result.adopted, ['.sheetagent']);
  assert.equal(fs.readFileSync(path.join(f.hostHomeDir, '.sheetagent', 'logs', 'mcp.log'), 'utf8'), 'account-log');
  assert.equal(fs.lstatSync(path.join(f.projectionRoot, '.sheetagent')).isSymbolicLink(), true);
});

test('real data on both sides is never merged or discarded', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.hostHomeDir, '.workbuddy'));
  fs.writeFileSync(path.join(f.hostHomeDir, '.workbuddy', 'workbuddy.db'), 'host-sessions');
  fs.mkdirSync(path.join(f.projectionRoot, '.workbuddy'));
  fs.writeFileSync(path.join(f.projectionRoot, '.workbuddy', 'workbuddy.db'), 'account-sessions');

  const result = f.link();

  assert.deepEqual(result.unresolved, ['.workbuddy']);
  assert.equal(fs.readFileSync(path.join(f.hostHomeDir, '.workbuddy', 'workbuddy.db'), 'utf8'), 'host-sessions');
  assert.equal(fs.readFileSync(path.join(f.projectionRoot, '.workbuddy', 'workbuddy.db'), 'utf8'), 'account-sessions');
});

test('a link to somewhere other than the host data root is reported, not replaced', (t) => {
  const f = fixture(t);
  const elsewhere = path.join(f.hostHomeDir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(f.hostHomeDir, '.workbuddy'));
  fs.symlinkSync(elsewhere, path.join(f.projectionRoot, '.workbuddy'), 'dir');

  assert.deepEqual(f.link().unresolved, ['.workbuddy']);
  assert.equal(fs.readlinkSync(path.join(f.projectionRoot, '.workbuddy')), elsewhere);
});

test('cache linking never deletes host data reached through a link to the host', (t) => {
  const f = fixture(t);
  const hostCache = path.join(f.hostHomeDir, 'Library', 'Caches', 'go-build');
  fs.mkdirSync(hostCache, { recursive: true });
  fs.writeFileSync(path.join(hostCache, 'entry'), 'host-cache');
  // 账号的 Library 整体就是宿主那一份：其中的共享缓存路径解析后与宿主相同。
  fs.symlinkSync(path.join(f.hostHomeDir, 'Library'), path.join(f.projectionRoot, 'Library'), 'dir');

  const result = linkSharedHostCaches({
    provider: 'workbuddycn', projectionRoot: f.projectionRoot, hostHomeDir: f.hostHomeDir, platform: 'darwin'
  });

  assert.equal(result.replaced.length, 0);
  assert.equal(fs.readFileSync(path.join(hostCache, 'entry'), 'utf8'), 'host-cache');
  assert.equal(fs.lstatSync(hostCache).isDirectory(), true);
});
