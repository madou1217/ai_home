'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readManagedAppConfig,
  saveManagedAppConfig,
  ToolkitConfigError
} = require('../lib/cli/services/toolkit/config-editor');

function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-toolkit-config-test-'));
}

test('config editor resolves a Codex Desktop alias without exposing a path contract', () => {
  const home = createHome();
  const data = readManagedAppConfig('codex-desktop', {
    hostHomeDir: home,
    platform: 'linux'
  });

  assert.equal(data.ok, true);
  assert.equal(data.appId, 'codex-desktop');
  assert.equal(data.configName, 'config.toml');
  assert.equal(data.configFormat, 'toml');
  assert.equal(data.exists, false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'path'), false);
});

test('config editor saves with an optimistic revision check', () => {
  const home = createHome();
  const configDir = path.join(home, '.codex');
  const configPath = path.join(configDir, 'config.toml');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf8');

  const before = readManagedAppConfig('codex', {
    hostHomeDir: home,
    platform: 'linux'
  });
  const saved = saveManagedAppConfig('codex', 'model = "gpt-5.5"\n', {
    hostHomeDir: home,
    platform: 'linux',
    expectedRevision: before.revision
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.elevated, false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "gpt-5.5"\n');
  assert.equal(saved.revision, readManagedAppConfig('codex', {
    hostHomeDir: home,
    platform: 'linux'
  }).revision);

  assert.throws(
    () => saveManagedAppConfig('codex', 'model = "stale"\n', {
      hostHomeDir: home,
      platform: 'linux',
      expectedRevision: before.revision
    }),
    (error) => error instanceof ToolkitConfigError && error.code === 'config_conflict'
  );
});

test('config editor falls back to Linux privilege elevation after EACCES', () => {
  const home = createHome();
  let denyNextWrite = true;
  const calls = [];
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') {
        return (...args) => {
          if (denyNextWrite) {
            denyNextWrite = false;
            const error = new Error('permission denied');
            error.code = 'EACCES';
            throw error;
          }
          return target.writeFileSync(...args);
        };
      }
      return Reflect.get(target, property, target);
    }
  });

  const result = saveManagedAppConfig('codex', 'model = "elevated"\n', {
    fs: fsImpl,
    hostHomeDir: home,
    platform: 'linux',
    spawnSync(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.elevated, true);
  assert.equal(calls[0].command, 'pkexec');
  assert.ok(calls[0].args.includes('/bin/sh'));
});

test('config editor uses Windows UAC elevation after EACCES', () => {
  const calls = [];
  const files = new Map();
  let writeCount = 0;
  const fsImpl = {
    existsSync() { return false; },
    accessSync() {},
    mkdirSync() {},
    statSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFileSync(file, content) {
      writeCount += 1;
      if (writeCount === 1) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      files.set(file, String(content));
    },
    chmodSync() {},
    mkdtempSync(prefix) { return `${prefix}1`; },
    rmSync() {},
    readdirSync() { return []; },
    unlinkSync() {},
    rmdirSync() {}
  };

  const result = saveManagedAppConfig('codex', 'model = "gpt-5.5"\n', {
    fs: fsImpl,
    os: { tmpdir() { return 'C:\\Temp'; } },
    hostHomeDir: 'C:\\Users\\tester',
    platform: 'win32',
    processObj: { platform: 'win32', env: {} },
    spawnSync(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.elevated, true);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  assert.equal(files.size, 1);
});
