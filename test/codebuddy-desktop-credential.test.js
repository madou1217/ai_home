'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { credential } = require('./helpers/codebuddy-credential');
const { readCodebuddyDesktopCredential, DECLARED_DESKTOP_DIR_NAMES } = require('../lib/account/codebuddy-desktop-credential');

const posix = nodePath.posix;
const AUTH_SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessToken"}';
const STATE_SEGMENTS = ['User', 'globalStorage', 'state.vscdb'];

// 各平台「用户数据根」父目录下的 App 目录（与 codebuddy-family-layouts 同源）。
const APP_DIR = Object.freeze({
  darwin: ['Library', 'Application Support', 'CodeBuddy'],
  linux: ['.local', 'share', 'CodeBuddy'],
  win32: ['AppData', 'Local', 'CodeBuddy']
});

function fixture(t) {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-desktop-cred-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// 把 safeStorage 的原始字节写进 Electron 的 state.vscdb（`ItemTable` 里那条扩展密钥）。
function writeStateDb(home, dirSegments, blob) {
  const file = posix.join(home, ...dirSegments, ...STATE_SEGMENTS);
  fs.mkdirSync(posix.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
    .run(AUTH_SECRET_KEY, JSON.stringify(blob));
  db.close();
  return file;
}

// macOS / Linux 共用 AES-128-CBC + PBKDF2(salt='saltysalt')，只有口令与迭代次数不同。
function aesBlob(value, password, iterations) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify(value)), cipher.final()]);
}

// 测试自造的口令，不是任何真实机器的钥匙串内容。
const KEYCHAIN_PASSWORD = 'fixture-safe-storage';
function macOptions(onService = () => {}) {
  return {
    platform: 'darwin',
    path: posix,
    execFileSync: (command, args) => {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args.slice(0, 3), ['find-generic-password', '-w', '-s']);
      onService(args[3]);
      return Buffer.from(`${KEYCHAIN_PASSWORD}\n`);
    }
  };
}

test('linux reads the peanuts-keyed safeStorage blob without any keychain', t => {
  const home = fixture(t), value = credential('codebuddy');
  // Chromium 在未接钥匙环时用固定口令 'peanuts' + 单次迭代。这是公开的确定性算法，
  // 所以 Linux 的读取能力可以用自造 fixture 证明，不依赖真机。
  writeStateDb(home, APP_DIR.linux, aesBlob(value, 'peanuts', 1));
  const read = readCodebuddyDesktopCredential(fs, home, 'codebuddy', {
    platform: 'linux',
    execFileSync: () => assert.fail('linux must not shell out for a keychain')
  });
  assert.deepEqual(read, value);
});

test('a linux blob keyed by libsecret is reported unavailable, never guessed', t => {
  const home = fixture(t);
  const blob = aesBlob(credential('codebuddy'), 'some-keyring-secret', 1);
  blob.write('v11', 0, 'latin1');
  writeStateDb(home, APP_DIR.linux, blob);
  // v11 的密钥在 libsecret 里：本模块不读钥匙环，必须明确不可用而不是用 peanuts 硬解。
  assert.equal(readCodebuddyDesktopCredential(fs, home, 'codebuddy', { platform: 'linux' }), null);
});

test('win32 hands the blob to DPAPI instead of an AES key', t => {
  const home = fixture(t), value = credential('codebuddy');
  // Windows 上没有 AES 层：v10 之后整段就是 DPAPI 密文。
  writeStateDb(home, APP_DIR.win32, Buffer.concat([Buffer.from('v10'), Buffer.from(JSON.stringify(value))]));
  const calls = [];
  const read = readCodebuddyDesktopCredential(fs, home, 'codebuddy', {
    platform: 'win32',
    path: posix,
    powershellPath: 'powershell.exe',
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      // 假 DPAPI：真实解密由 CryptUnprotectData 完成。这里证明的是「剥掉 v10 前缀后把
      // 整段交给平台解密器」这条接线，而不是 AES 路径。
      return Buffer.from(String(options.input), 'base64').toString('base64');
    }
  });
  assert.deepEqual(read, value);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(calls[0].args[3], /System\.Security\.Cryptography\.ProtectedData/);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'ignore']);
});

test('an undeclared App name is still found by scanning, attributed by the directory it lives in', t => {
  const home = fixture(t), value = credential('codebuddy');
  // 场景：客户端从安装包里直接打开，或应用被改名——目录名不在已知表里。
  // 归属只按扩展 ID 特征判定，服务名由**发现的目录**推导，否则改名后解不开自己的条目。
  writeStateDb(home, ['Library', 'Application Support', 'Renamed Buddy'], aesBlob(value, KEYCHAIN_PASSWORD, 1003));
  const services = [];
  const read = readCodebuddyDesktopCredential(fs, home, 'codebuddy', {
    ...macOptions(service => services.push(service)),
    scanCacheTtlMs: 0
  });
  assert.deepEqual(read, value);
  assert.deepEqual(services, ['Renamed Buddy Safe Storage']);
});

test('a declared App name wins and the scan never runs', t => {
  const home = fixture(t);
  const declared = credential('codebuddy', { uid: 'declared-user' });
  const renamed = credential('codebuddy', { uid: 'renamed-user' });
  writeStateDb(home, APP_DIR.darwin, aesBlob(declared, KEYCHAIN_PASSWORD, 1003));
  writeStateDb(home, ['Library', 'Application Support', 'Renamed Buddy'], aesBlob(renamed, KEYCHAIN_PASSWORD, 1003));
  const services = [];
  const read = readCodebuddyDesktopCredential(fs, home, 'codebuddy', {
    ...macOptions(service => services.push(service)),
    scanCacheTtlMs: 0
  });
  assert.deepEqual(read, declared);
  // 已认领的目录名不会被扫描重复读取：整个选择过程只碰一次钥匙串。
  assert.deepEqual(services, ['CodeBuddy Safe Storage']);
});

test('desktop credentials never leak across platforms', t => {
  const home = fixture(t);
  writeStateDb(home, APP_DIR.darwin, aesBlob(credential('codebuddy'), KEYCHAIN_PASSWORD, 1003));
  // 只有 darwin 的位置被写入时，linux/win32 必须看不到它。
  assert.equal(readCodebuddyDesktopCredential(fs, home, 'codebuddy', { platform: 'linux' }), null);
  assert.equal(readCodebuddyDesktopCredential(fs, home, 'codebuddy', { platform: 'win32', path: posix }), null);
  assert.ok(readCodebuddyDesktopCredential(fs, home, 'codebuddy', macOptions()));
});

test('only the CodeBuddy IDE needs a desktop store; WorkBuddy keeps to its shared .info', t => {
  const home = fixture(t);
  writeStateDb(home, ['Library', 'Application Support', 'WorkBuddy AI'],
    aesBlob(credential('workbuddy'), KEYCHAIN_PASSWORD, 1003));
  // WorkBuddy 桌面端与它内嵌的 CLI 读写同一个共享 .info，因此这里不为它声明 App 名：
  // 即使库里有家族的密钥也不该返回，避免引入"桌面端另续期一份"这个不存在的机制。
  for (const provider of ['workbuddy', 'workbuddycn']) {
    assert.equal(readCodebuddyDesktopCredential(fs, home, provider, {
      ...macOptions(() => assert.fail(`${provider} must not read a desktop store`)),
      scanCacheTtlMs: 0
    }), null);
  }
});

test('an unreadable blob is skipped rather than reported as the credential', t => {
  const home = fixture(t);
  // 前缀合法但内容不是有效密文：必须返回 null，让上层回退到共享 .info。
  writeStateDb(home, APP_DIR.darwin, Buffer.concat([Buffer.from('v10'), Buffer.from('not-encrypted-at-all')]));
  assert.equal(readCodebuddyDesktopCredential(fs, home, 'codebuddy', macOptions()), null);
});

test('the declared App name set covers exactly the two CodeBuddy IDE builds', () => {
  assert.deepEqual([...DECLARED_DESKTOP_DIR_NAMES], ['CodeBuddy', 'CodeBuddy CN']);
});
