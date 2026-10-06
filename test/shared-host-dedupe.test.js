'use strict';

// 同版本的应用解压内容（Kimi daimon-bundle）与宿主逐文件硬链接去重：各账号仍有自己的
// 目录树（应用升级时各自重新解压、互不影响），同版本文件在磁盘上只存一份。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dedupeSharedHostFiles } = require('../lib/runtime/shared-host-dedupe');

const PLATFORM = 'win32';
const HOST_BUNDLE = ['AppData', 'Roaming', 'kimi-desktop', 'daimon-bundle'];
const ACCOUNT_BUNDLE = ['electron-user-data', 'daimon-bundle'];

function setup(t, { hostStamp = '0.5.63|win32-x64', accountStamp = '0.5.63|win32-x64' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shared-host-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'host');
  const projectionRoot = path.join(root, 'projection');
  const hostDir = path.join(hostHomeDir, ...HOST_BUNDLE);
  const accountDir = path.join(projectionRoot, ...ACCOUNT_BUNDLE);
  const write = (dir, rel, content) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write(hostDir, '.daimon-bundle-stamp', hostStamp);
  write(accountDir, '.daimon-bundle-stamp', accountStamp);
  const run = () => dedupeSharedHostFiles({ provider: 'kimi', projectionRoot, hostHomeDir, platform: PLATFORM });
  const sameInode = (rel) => {
    const a = fs.statSync(path.join(accountDir, rel), { bigint: true });
    const h = fs.statSync(path.join(hostDir, rel), { bigint: true });
    return a.dev === h.dev && a.ino === h.ino;
  };
  return { root, hostDir, accountDir, projectionRoot, write, run, sameInode };
}

test('identical files of the same bundle version become hardlinks to the host copy', (t) => {
  const f = setup(t);
  for (const dir of [f.hostDir, f.accountDir]) {
    f.write(dir, 'runtime/uv/uv.exe', 'UV-BINARY');
    f.write(dir, 'app/daimon/dist/index.js', 'DAIMON');
  }

  const first = f.run();

  assert.equal(first.linked, 3, 'two payload files plus the identical stamp');
  assert.equal(first.failed, 0);
  assert.equal(f.sameInode('runtime/uv/uv.exe'), true);
  assert.equal(f.sameInode('app/daimon/dist/index.js'), true);
  assert.equal(fs.readFileSync(path.join(f.accountDir, 'runtime/uv/uv.exe'), 'utf8'), 'UV-BINARY');
  assert.deepEqual(fs.readdirSync(path.join(f.accountDir, 'runtime/uv')), ['uv.exe'], 'no temp names left behind');

  const second = f.run();
  assert.equal(second.linked, 0, 'already-shared inodes are skipped');
  assert.equal(second.alreadyShared, 3);
});

test('a different bundle version is never touched', (t) => {
  const f = setup(t, { accountStamp: '0.5.54|win32-x64' });
  for (const dir of [f.hostDir, f.accountDir]) f.write(dir, 'runtime/uv/uv.exe', 'UV-BINARY');

  const result = f.run();

  assert.equal(result.linked, 0);
  assert.deepEqual(result.skipped, [path.join(...ACCOUNT_BUNDLE)]);
  assert.equal(f.sameInode('runtime/uv/uv.exe'), false);
});

test('files whose content differs are never linked, even at the same size', (t) => {
  const f = setup(t);
  f.write(f.hostDir, 'config.json', 'AAAA');
  f.write(f.accountDir, 'config.json', 'BBBB');
  f.write(f.accountDir, 'account-only.json', 'ONLY-HERE');

  const result = f.run();

  assert.equal(result.linked, 1, 'only the stamp matches');
  assert.equal(fs.readFileSync(path.join(f.accountDir, 'config.json'), 'utf8'), 'BBBB');
  assert.equal(fs.readFileSync(path.join(f.accountDir, 'account-only.json'), 'utf8'), 'ONLY-HERE');
});

test('deleting the account projection keeps the host bundle intact', (t) => {
  const f = setup(t);
  for (const dir of [f.hostDir, f.accountDir]) f.write(dir, 'runtime/git/bin/git.exe', 'GIT');
  f.run();

  fs.rmSync(f.projectionRoot, { recursive: true, force: true });

  assert.equal(fs.readFileSync(path.join(f.hostDir, 'runtime/git/bin/git.exe'), 'utf8'), 'GIT');
});

test('a missing host bundle is a no-op', (t) => {
  const f = setup(t);
  fs.rmSync(path.join(f.hostDir, '.daimon-bundle-stamp'));
  f.write(f.accountDir, 'runtime/uv/uv.exe', 'UV-BINARY');
  assert.equal(f.run().linked, 0);
});
