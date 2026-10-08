'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let shadowApp = null;
try {
  shadowApp = require('../lib/runtime/zcode-electron-shadow-app');
} catch (_error) {}

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const ORIGINAL_MAIN_PATH = 'out/main/index.js';
const BOOTSTRAP_ENTRY_PATH = 'node_modules/yaml/bin.mjs';
const AGENT_RUNTIME_ENTRY_PATH = 'out/host/chunk-MZDDONWW.js';
const AGENT_RUNTIME_MARKER = 'cwd:process.env.ZCODE_AGENT_SERVER_CWD?.trim()||r.workspacePath';

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
    [AGENT_RUNTIME_ENTRY_PATH]: `function xn(r){let e=process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();if(e)return Nn({command:e,args:Oi(process.env.ZCODE_AGENT_SERVER_ARGS_JSON)??["app-server","--stdio"],${AGENT_RUNTIME_MARKER}},r.presentationSurface);return Nn(r,r.presentationSurface);}`,
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
  assert.match(bootstrapSource, /\.\.\/\.\.\/\.\.\/aih-zcode-captcha-hook\.cjs/);
  assert.equal(bootstrapSource.includes('process.env'), false);
  assert.deepEqual(
    fs.readFileSync(path.join(first.resolved.bundlePath, 'Contents', 'Resources', 'aih-zcode-captcha-hook.cjs')),
    fs.readFileSync(fixture.hookModulePath),
    'hook 随影子 App 发布，不依赖仓库的运行时位置'
  );
  assert.match(bootstrapSource, /await import\("\.\.\/\.\.\/out\/main\/index\.js"\)/);
  const patchedRuntime = shadowParsed.readEntry(AGENT_RUNTIME_ENTRY_PATH).content.toString('utf8');
  assert.match(patchedRuntime, /supportsStorageStartup:!0,storagePreparationEntry:e/);
  assert.match(patchedRuntime, /args:Oi\(process\.env\.ZCODE_AGENT_SERVER_ARGS_JSON\)\?\?\["app-server","--stdio"\],/);
  assert.equal(patchedRuntime.includes(AGENT_RUNTIME_MARKER), false);
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

test('影子 App 从自身资源加载 hook，缺失或过期的启动环境不阻断原生主进程', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(fixture.hookModulePath, 'globalThis.__aihBundledHookLoaded = true;\n');
  const prepared = shadowApp.prepareZcodeElectronShadowApp({
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir: fixture.profileDir,
    hookModulePath: fixture.hookModulePath,
    cloneBundle(source, target) { fs.cpSync(source, target, { recursive: true }); },
    signBundle() {},
    verifyBundle() { return true; }
  });
  assert.equal(prepared.ready, true);
  const resourcesPath = path.join(prepared.resolved.bundlePath, 'Contents', 'Resources');
  const archive = readAsar(path.join(resourcesPath, 'app.asar'));
  // Node 不读取 ASAR，将相同相对布局解包后执行真正的 ESM 入口。
  const extractedResources = path.join(fixture.root, 'extracted', 'Resources');
  const entryPath = path.join(extractedResources, 'app.asar', BOOTSTRAP_ENTRY_PATH);
  const mainPath = path.join(extractedResources, 'app.asar', ORIGINAL_MAIN_PATH);
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(entryPath, archive.readEntry(BOOTSTRAP_ENTRY_PATH).content);
  fs.writeFileSync(mainPath, 'if (!globalThis.__aihBundledHookLoaded) throw new Error("hook_not_loaded");\nconsole.log("zcode_main_loaded");\n');
  const bundledHookPath = path.join(resourcesPath, 'aih-zcode-captcha-hook.cjs');
  if (fs.existsSync(bundledHookPath)) {
    fs.copyFileSync(bundledHookPath, path.join(extractedResources, 'aih-zcode-captcha-hook.cjs'));
  }
  fs.writeFileSync(fixture.hookModulePath, 'throw new Error("external_hook_must_not_be_loaded");\n');
  for (const hookPath of [undefined, path.join(fixture.root, 'removed-repo', 'hook.js'), fixture.hookModulePath]) {
    const env = { ...process.env };
    delete env.AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH;
    if (hookPath) env.AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH = hookPath;
    const result = spawnSync(process.execPath, [entryPath], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'zcode_main_loaded');
  }
});

test('影子 App 缓存中的 hook 丢失或内容变化时重新准备并校验', (t) => {
  const fixture = createFixture(t);
  let clones = 0;
  const prepare = () => shadowApp.prepareZcodeElectronShadowApp({
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir: fixture.profileDir,
    hookModulePath: fixture.hookModulePath,
    cloneBundle(source, target) {
      clones += 1;
      fs.cpSync(source, target, { recursive: true });
    },
    signBundle() {},
    verifyBundle() { return true; }
  });
  const first = prepare();
  assert.equal(first.ready, true);
  const hookPath = path.join(first.resolved.bundlePath, 'Contents', 'Resources', 'aih-zcode-captcha-hook.cjs');
  for (const corrupt of [() => fs.unlinkSync(hookPath), () => fs.writeFileSync(hookPath, 'corrupted')]) {
    corrupt();
    const repaired = prepare();
    assert.equal(repaired.ready, true);
    assert.equal(repaired.status, 'prepared');
    assert.equal(repaired.resolved.bundlePath, first.resolved.bundlePath);
    assert.deepEqual(fs.readFileSync(hookPath), fs.readFileSync(fixture.hookModulePath));
  }
  assert.equal(clones, 3);
  assert.equal(prepare().status, 'reused');
  assert.equal(clones, 3);
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

test('影子 App 全机按指纹共享一份：不同账号复用同一份，账号内旧影子与久未使用的旧指纹被清理', (t) => {
  const fixture = createFixture(t);
  const shadowRoot = path.join(path.dirname(fixture.profileDir), 'shared-zcode-shadow');
  const calls = { clone: 0 };
  const prepare = (profileDir) => shadowApp.prepareZcodeElectronShadowApp({
    fs,
    path,
    sourceBundlePath: fixture.sourceBundlePath,
    profileDir,
    shadowRoot,
    hookModulePath: fixture.hookModulePath,
    cloneBundle(source, target) {
      calls.clone += 1;
      fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    },
    signBundle() {},
    verifyBundle() { return true; }
  });
  // 旧版本留在账号投影里的影子、一个久未使用的旧指纹、一个最近用过的旧指纹。
  const legacy = path.join(fixture.profileDir, '.aih-runtime', 'zcode-shadow', 'old', 'ZCode.app');
  fs.mkdirSync(legacy, { recursive: true });
  const staleManifest = path.join(shadowRoot, 'stalefingerprint', 'manifest.json');
  const recentManifest = path.join(shadowRoot, 'recentfingerprint', 'manifest.json');
  for (const manifest of [staleManifest, recentManifest]) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{}');
  }
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleManifest, longAgo, longAgo);

  const first = prepare(fixture.profileDir);
  const otherAccount = path.join(path.dirname(fixture.profileDir), 'other-account');
  fs.mkdirSync(otherAccount, { recursive: true });
  const second = prepare(otherAccount);

  assert.equal(first.ready, true);
  assert.equal(second.status, 'reused');
  assert.equal(second.resolved.bundlePath, first.resolved.bundlePath, '所有账号复用同一份影子');
  assert.ok(first.resolved.bundlePath.startsWith(`${shadowRoot}${path.sep}`));
  assert.equal(calls.clone, 1);
  assert.equal(fs.existsSync(path.join(fixture.profileDir, '.aih-runtime', 'zcode-shadow')), false, '账号内旧影子已删除');
  assert.equal(fs.existsSync(path.dirname(staleManifest)), false, '久未使用的旧指纹已清理');
  assert.equal(fs.existsSync(path.dirname(recentManifest)), true, '最近用过的旧指纹保留（可能仍有实例在用）');
});
