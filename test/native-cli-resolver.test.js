'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveEnvCliPath, resolveNativeCliPath } = require('../lib/runtime/native-cli-resolver');

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
