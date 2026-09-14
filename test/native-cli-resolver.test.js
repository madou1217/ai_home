'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  repairUnversionedShim,
  resolveEnvCliPath,
  resolveNativeCliPath,
  resolveVersionedWindowsExecutable
} = require('../lib/runtime/native-cli-resolver');

test('resolveEnvCliPath skips empty Windows shim and selects latest versioned executable', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(binDir, 'qoderclicn.exe'), '');
  fs.writeFileSync(path.join(binDir, 'qoderclicn-1.1.2.exe'), 'binary');
  fs.writeFileSync(path.join(binDir, 'qoderclicn-1.2.0.exe'), 'binary');

  assert.equal(resolveEnvCliPath('qoderclicn', {
    platform: 'win32',
    env: { Path: binDir }
  }), path.join(binDir, 'qoderclicn-1.2.0.exe'));
});

test('resolveNativeCliPath rejects an empty executable returned by the platform resolver', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-platform-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(binDir, 'qoderclicn.exe'), '');
  fs.writeFileSync(path.join(binDir, 'qoderclicn-1.1.2.exe'), 'binary');

  assert.equal(resolveNativeCliPath('qoderclicn', {
    platform: 'win32',
    env: { Path: binDir },
    projectFallback: false
  }), path.join(binDir, 'qoderclicn-1.1.2.exe'));
});

test('resolveVersionedWindowsExecutable repairs a broken unversioned shim as a hardlink', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-heal-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const shim = path.join(binDir, 'qoderclicn.exe');
  const target = path.join(binDir, 'qoderclicn-1.1.51.exe');
  fs.writeFileSync(shim, '');
  fs.writeFileSync(target, 'binary');

  assert.equal(resolveVersionedWindowsExecutable('qoderclicn', binDir, { platform: 'win32' }), target);

  const shimStat = fs.statSync(shim);
  const targetStat = fs.statSync(target);
  assert.ok(shimStat.size > 0, 'shim should become a non-empty executable');
  assert.equal(shimStat.ino, targetStat.ino, 'shim should be a hardlink to the resolved binary');
});

test('resolveVersionedWindowsExecutable re-points a stale working shim at the newest version', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-repoint-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const shim = path.join(binDir, 'qoderclicn.exe');
  const target = path.join(binDir, 'qoderclicn-1.2.0.exe');
  fs.writeFileSync(shim, 'stale-copy');
  fs.writeFileSync(path.join(binDir, 'qoderclicn-1.1.2.exe'), 'binary');
  fs.writeFileSync(target, 'binary');

  assert.equal(resolveVersionedWindowsExecutable('qoderclicn', binDir, { platform: 'win32' }), target);
  assert.equal(fs.statSync(shim).ino, fs.statSync(target).ino);
});

test('repairUnversionedShim keeps a matching hardlink untouched', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-keep-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const shim = path.join(binDir, 'qoderclicn.exe');
  const target = path.join(binDir, 'qoderclicn-1.1.51.exe');
  fs.writeFileSync(target, 'binary');
  fs.linkSync(target, shim);
  const before = fs.statSync(shim);

  repairUnversionedShim(binDir, 'qoderclicn', target, { platform: 'win32' });

  const after = fs.statSync(shim);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, before.nlink);
});

test('resolveVersionedWindowsExecutable never repairs through an injected fs double', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-pure-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const shim = path.join(binDir, 'qoderclicn.exe');
  fs.writeFileSync(shim, '');
  fs.writeFileSync(path.join(binDir, 'qoderclicn-1.1.51.exe'), 'binary');
  const fsDouble = { ...fs };

  const resolved = resolveVersionedWindowsExecutable('qoderclicn', binDir, { platform: 'win32', fs: fsDouble });

  assert.equal(resolved, path.join(binDir, 'qoderclicn-1.1.51.exe'));
  assert.equal(fs.statSync(shim).size, 0, 'injected fs must not trigger filesystem side effects');
});
