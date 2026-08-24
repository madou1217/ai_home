'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let shadowApp = null;
try {
  shadowApp = require('../lib/runtime/zcode-electron-shadow-app');
} catch (_error) {}

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const ORIGINAL_MAIN_PATH = 'out/main/index.js';
const BOOTSTRAP_ENTRY_PATH = 'node_modules/yaml/bin.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildStringPickle(value) {
  const text = Buffer.from(value, 'utf8');
  const payloadSizeWithoutPadding = 4 + text.length + 1;
  const paddingSize = (4 - (payloadSizeWithoutPadding % 4)) % 4;
  const payloadSize = payloadSizeWithoutPadding + paddingSize;
  const pickle = Buffer.alloc(4 + payloadSize);
  pickle.writeUInt32LE(payloadSize, 0);
  pickle.writeUInt32LE(text.length, 4);
  text.copy(pickle, 8);
  return pickle;
}

function addAsarEntry(root, entryPath, entry) {
  const parts = entryPath.split('/');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    current.files[part] ||= { files: {} };
    current = current.files[part];
  }
  current.files[parts.at(-1)] = entry;
}

function writeAsar(asarPath, files) {
  const header = { files: {} };
  const payloads = [];
  let offset = 0;
  for (const [entryPath, value] of Object.entries(files)) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    addAsarEntry(header, entryPath, {
      size: content.length,
      offset: String(offset),
      integrity: {
        algorithm: 'SHA256',
        hash: sha256(content),
        blockSize: 4194304,
        blocks: [sha256(content)]
      }
    });
    payloads.push(content);
    offset += content.length;
  }
  const headerPickle = buildStringPickle(JSON.stringify(header));
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...payloads]));
}

function readAsar(asarPath) {
  const archive = fs.readFileSync(asarPath);
  const headerSize = archive.readUInt32LE(4);
  const headerJsonSize = archive.readUInt32LE(12);
  const headerBytes = archive.subarray(8, 8 + headerSize);
  const header = JSON.parse(archive.subarray(16, 16 + headerJsonSize).toString('utf8'));
  function readEntry(entryPath) {
    let entry = header;
    for (const part of entryPath.split('/')) entry = entry.files[part];
    const start = 8 + headerSize + Number(entry.offset || 0);
    return {
      entry,
      content: archive.subarray(start, start + Number(entry.size))
    };
  }
  return { archive, headerBytes, readEntry };
}

function createFixture(t, fuseWire = '101100011') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-shadow-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceBundlePath = path.join(root, 'source', 'ZCode.app');
  const profileDir = path.join(root, 'profile');
  const executablePath = path.join(sourceBundlePath, 'Contents', 'MacOS', 'ZCode');
  const frameworkPath = path.join(
    sourceBundlePath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  );
  const asarPath = path.join(sourceBundlePath, 'Contents', 'Resources', 'app.asar');
  const hookModulePath = path.join(root, 'repo', 'zcode-electron-captcha-hook.js');
  const packageJson = `${JSON.stringify({
    name: '@zcode/desktop',
    type: 'module',
    main: ORIGINAL_MAIN_PATH,
    version: '3.8.1'
  }, null, 2)}\n${' '.repeat(256)}`;
  const yamlPackageJson = JSON.stringify({
    name: 'yaml',
    bin: './bin.mjs',
    exports: { '.': './dist/index.js' }
  });
  const yamlBin = Buffer.alloc(310, 0x20);
  Buffer.from('#!/usr/bin/env node\nconsole.log("yaml cli");\n').copy(yamlBin);
  writeAsar(asarPath, {
    [ORIGINAL_MAIN_PATH]: 'globalThis.__zcodeOriginalMainLoaded = true;\n',
    'package.json': packageJson,
    'node_modules/yaml/package.json': yamlPackageJson,
    [BOOTSTRAP_ENTRY_PATH]: yamlBin,
    'node_modules/yaml/dist/index.js': 'export const parse = () => ({});\n'
  });
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, 'zcode executable');
  fs.chmodSync(executablePath, 0o755);
  fs.mkdirSync(path.dirname(frameworkPath), { recursive: true });
  fs.writeFileSync(frameworkPath, Buffer.concat([
    Buffer.alloc(64, 0x41),
    FUSE_SENTINEL,
    Buffer.from([1, fuseWire.length]),
    Buffer.from(fuseWire, 'ascii'),
    Buffer.alloc(64, 0x42)
  ]));
  fs.mkdirSync(path.dirname(hookModulePath), { recursive: true });
  fs.writeFileSync(hookModulePath, 'module.exports = {};\n');
  return { root, sourceBundlePath, profileDir, asarPath, hookModulePath };
}

test('ZCode 影子 App 只固定长度改写 ASAR 数据区，原包与 ASAR 头保持不变且可幂等复用', (t) => {
  assert.ok(shadowApp, '应提供 zcode-electron-shadow-app runtime');
  const fixture = createFixture(t);
  const sourceBefore = fs.readFileSync(fixture.asarPath);
  const sourceParsed = readAsar(fixture.asarPath);
  const calls = { clone: 0, sign: 0, verify: 0 };
  const options = {
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir: fixture.profileDir,
    hookModulePath: fixture.hookModulePath,
    cloneBundle(source, target) {
      calls.clone += 1;
      fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    },
    signBundle() {
      calls.sign += 1;
    },
    verifyBundle() {
      calls.verify += 1;
      return true;
    }
  };

  const first = shadowApp.prepareZcodeElectronShadowApp(options);
  assert.equal(first.ready, true);
  assert.equal(first.status, 'prepared');
  assert.match(first.resolved.bundlePath, /\.aih-runtime\/zcode-shadow\/[a-f0-9]{16}\/ZCode\.app$/);
  assert.equal(
    first.resolved.executablePath,
    path.join(first.resolved.bundlePath, 'Contents', 'MacOS', 'ZCode')
  );
  assert.deepEqual(fs.readFileSync(fixture.asarPath), sourceBefore, '原始已签名 App 不得修改');

  const shadowAsarPath = path.join(first.resolved.bundlePath, 'Contents', 'Resources', 'app.asar');
  const shadowParsed = readAsar(shadowAsarPath);
  assert.deepEqual(shadowParsed.headerBytes, sourceParsed.headerBytes, 'ASAR 头与嵌入摘要保持原样');
  const patchedPackage = JSON.parse(shadowParsed.readEntry('package.json').content.toString('utf8'));
  assert.equal(patchedPackage.main, BOOTSTRAP_ENTRY_PATH);
  const bootstrapEntry = shadowParsed.readEntry(BOOTSTRAP_ENTRY_PATH);
  assert.equal(
    bootstrapEntry.content.length,
    sourceParsed.readEntry(BOOTSTRAP_ENTRY_PATH).content.length,
    '数据区 entry 必须固定长度，不能移动后续文件 offset'
  );
  const bootstrapSource = bootstrapEntry.content.toString('utf8');
  assert.match(bootstrapSource, /AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH/);
  assert.match(bootstrapSource, /await import\("\.\.\/\.\.\/out\/main\/index\.js"\)/);
  assert.deepEqual(calls, { clone: 1, sign: 1, verify: 1 });

  const second = shadowApp.prepareZcodeElectronShadowApp(options);
  assert.equal(second.ready, true);
  assert.equal(second.status, 'reused');
  assert.equal(second.resolved.bundlePath, first.resolved.bundlePath);
  assert.deepEqual(calls, { clone: 1, sign: 1, verify: 2 });
});

test('Electron 启用 embedded ASAR integrity 时失败关闭，不制作不可信影子包', (t) => {
  assert.ok(shadowApp, '应提供 zcode-electron-shadow-app runtime');
  const fixture = createFixture(t, '101110011');
  let cloneCalls = 0;

  const result = shadowApp.prepareZcodeElectronShadowApp({
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir: fixture.profileDir,
    hookModulePath: fixture.hookModulePath,
    cloneBundle() {
      cloneCalls += 1;
    }
  });

  assert.equal(result.ready, false);
  assert.equal(result.error, 'zcode_captcha_shadow_integrity_enabled');
  assert.equal(cloneCalls, 0);
});

test('ad-hoc 签名只重签外层 App，保留内部 Electron Framework 的原始有效签名', (t) => {
  assert.ok(shadowApp, '应提供 zcode-electron-shadow-app runtime');
  const fixture = createFixture(t);
  const calls = [];

  const result = shadowApp.prepareZcodeElectronShadowApp({
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir: fixture.profileDir,
    hookModulePath: fixture.hookModulePath,
    cloneBundle(source, target) {
      fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    },
    execFileSync(file, args) {
      calls.push({ file, args });
      return Buffer.alloc(0);
    }
  });

  assert.equal(result.ready, true);
  const signCall = calls.find((call) => call.args.includes('--sign'));
  const verifyCall = calls.find((call) => call.args.includes('--verify'));
  assert.ok(signCall);
  assert.equal(signCall.args.includes('--deep'), false, '重签内部 Framework 会触发 codesign internal error');
  assert.ok(verifyCall);
  assert.equal(verifyCall.args.includes('--deep'), true, '最终仍需深度验证整包嵌套签名');
});
