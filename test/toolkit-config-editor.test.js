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

test('config editor rejects tool IDs unless tool discovery supplied an explicit target', () => {
  const home = createHome();
  assert.throws(
    () => readManagedAppConfig('frpc', { hostHomeDir: home, platform: 'linux' }),
    (error) => error instanceof ToolkitConfigError && error.code === 'unsupported_app'
  );
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
  const elevatedCommand = calls[0].args[calls[0].args.indexOf('-c') + 1];
  assert.match(elevatedCommand, /\/usr\/bin\/install -m 600 --/);
  assert.match(elevatedCommand, /config\.toml\.aih-edit-\d+-[0-9a-f]+/);
  assert.match(elevatedCommand, /\/bin\/mv -f --/);
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
  const outerEncoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1];
  const outerScript = Buffer.from(outerEncoded, 'base64').toString('utf16le');
  const innerEncoded = outerScript.match(/\$innerEncoded = '([^']+)'/)?.[1] || '';
  const innerScript = Buffer.from(innerEncoded, 'base64').toString('utf16le');
  assert.match(innerScript, /Copy-Item -LiteralPath/);
  assert.match(innerScript, /\.aih-edit-\d+-[0-9a-f]+/);
  assert.match(innerScript, /\[IO\.File\]::Replace\(/);
  assert.match(innerScript, /\[IO\.File\]::Move\(/);
  assert.match(innerScript, /Remove-Item -LiteralPath/);
  assert.equal(files.size, 1);
});

test('config editor does not expose a config path through read failures', () => {
  const home = '/private/example-user';
  const targetPath = path.join(home, '.codex', 'config.toml');
  assert.throws(
    () => readManagedAppConfig('codex', {
      hostHomeDir: home,
      platform: 'linux',
      fs: {
        existsSync(candidate) { return candidate === targetPath; },
        realpathSync(candidate) { return candidate; },
        accessSync() {},
        readFileSync() {
          throw Object.assign(new Error(`I/O failure at ${targetPath}`), { code: 'EIO' });
        }
      }
    }),
    (error) => error instanceof ToolkitConfigError
      && error.code === 'config_read_failed'
      && !error.message.includes(targetPath)
  );
});

test('config editor does not expose a config path through save failures', () => {
  const home = '/private/example-user';
  const targetPath = path.join(home, '.codex', 'config.toml');
  assert.throws(
    () => saveManagedAppConfig('codex', 'model = "example"\n', {
      hostHomeDir: home,
      platform: 'linux',
      fs: {
        existsSync() { return false; },
        mkdirSync() {},
        statSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        writeFileSync() {
          throw Object.assign(new Error(`I/O failure at ${targetPath}`), { code: 'EIO' });
        },
        unlinkSync() {}
      }
    }),
    (error) => error instanceof ToolkitConfigError
      && error.code === 'config_save_failed'
      && !error.message.includes(targetPath)
  );
});

test('config editor preserves an existing config symlink during atomic save', (t) => {
  if (process.platform === 'win32') return;
  const home = createHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.codex');
  const targetDir = path.join(home, 'shared');
  const linkPath = path.join(configDir, 'config.toml');
  const targetPath = path.join(targetDir, 'codex.toml');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, 'model = "before"\n', 'utf8');
  fs.symlinkSync(targetPath, linkPath);

  const before = readManagedAppConfig('codex', { hostHomeDir: home, platform: 'linux' });
  saveManagedAppConfig('codex', 'model = "after"\n', {
    hostHomeDir: home,
    platform: 'linux',
    expectedRevision: before.revision
  });

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'model = "after"\n');
});

test('config editor never unlinks the original file when atomic rename is denied', () => {
  const home = createHome();
  const configDir = path.join(home, '.codex');
  const configPath = path.join(configDir, 'config.toml');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, 'model = "original"\n', 'utf8');
  let originalUnlinked = false;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return () => {
          const error = new Error('rename denied');
          error.code = 'EPERM';
          throw error;
        };
      }
      if (property === 'unlinkSync') {
        return (candidate) => {
          if (candidate === configPath) originalUnlinked = true;
          else target.unlinkSync(candidate);
        };
      }
      return Reflect.get(target, property, target);
    }
  });

  const result = saveManagedAppConfig('codex', 'model = "replacement"\n', {
    fs: fsImpl,
    hostHomeDir: home,
    platform: 'linux',
    spawnSync() {
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.elevated, true);
  assert.equal(originalUnlinked, false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "original"\n');
});
