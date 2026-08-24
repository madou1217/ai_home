'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

const AIH_ZCODE_CAPTCHA_HOOK_MODULE_ENV = 'AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH';
const SHADOW_LAYOUT_VERSION = 1;
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX = 4;
const ORIGINAL_MAIN_PATH = 'out/main/index.js';
const BOOTSTRAP_ENTRY_PATH = 'node_modules/yaml/bin.mjs';
const YAML_PACKAGE_PATH = 'node_modules/yaml/package.json';
const MAX_ASAR_HEADER_SIZE = 64 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function failure(error, reason) {
  const normalizedReason = String(reason || '').trim();
  return {
    ready: false,
    error,
    ...(normalizedReason ? { reason: normalizedReason.slice(0, 160) } : {})
  };
}

function readExact(fsImpl, fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fsImpl.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!count) throw new Error('unexpected_eof');
    offset += count;
  }
  return buffer;
}

function writeExact(fsImpl, fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fsImpl.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!count) throw new Error('short_write');
    offset += count;
  }
}

function readAsarMetadata(fsImpl, asarPath) {
  const fd = fsImpl.openSync(asarPath, 'r');
  try {
    const prefix = readExact(fsImpl, fd, Buffer.alloc(16), 0);
    if (prefix.readUInt32LE(0) !== 4) throw new Error('invalid_asar_size_pickle');
    const headerSize = prefix.readUInt32LE(4);
    const headerPayloadSize = prefix.readUInt32LE(8);
    const headerJsonSize = prefix.readUInt32LE(12);
    if (headerSize < 12 || headerSize > MAX_ASAR_HEADER_SIZE) {
      throw new Error('invalid_asar_header_size');
    }
    if (headerPayloadSize + 4 !== headerSize || headerJsonSize > headerSize - 8) {
      throw new Error('invalid_asar_header_pickle');
    }
    const headerBytes = readExact(fsImpl, fd, Buffer.alloc(headerSize), 8);
    const header = JSON.parse(headerBytes.subarray(8, 8 + headerJsonSize).toString('utf8'));
    return {
      dataOffset: 8 + headerSize,
      header,
      headerBytes,
      headerHash: sha256(headerBytes)
    };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function resolveAsarEntry(metadata, entryPath) {
  let entry = metadata.header;
  for (const part of String(entryPath || '').split('/').filter(Boolean)) {
    entry = entry && entry.files && entry.files[part];
    if (!entry) throw new Error(`missing_asar_entry:${entryPath}`);
  }
  const size = Number(entry.size);
  const offset = Number(entry.offset);
  if (entry.unpacked || !Number.isSafeInteger(size) || size < 0
    || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`unsupported_asar_entry:${entryPath}`);
  }
  return {
    ...entry,
    absoluteOffset: metadata.dataOffset + offset,
    size
  };
}

function readAsarEntry(fsImpl, asarPath, metadata, entryPath) {
  const entry = resolveAsarEntry(metadata, entryPath);
  const fd = fsImpl.openSync(asarPath, 'r');
  try {
    return {
      entry,
      content: readExact(fsImpl, fd, Buffer.alloc(entry.size), entry.absoluteOffset)
    };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function assertEntryIntegrity(entryPath, entry, content) {
  const expected = String(entry.integrity && entry.integrity.hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(content) !== expected) {
    throw new Error(`asar_entry_integrity_mismatch:${entryPath}`);
  }
}

function findFuseSentinel(fsImpl, binaryPath) {
  const fd = fsImpl.openSync(binaryPath, 'r');
  const chunkSize = 1024 * 1024;
  const overlapSize = FUSE_SENTINEL.length - 1;
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(chunkSize);
      const count = fsImpl.readSync(fd, chunk, 0, chunk.length, position);
      if (!count) return -1;
      const data = Buffer.concat([carry, chunk.subarray(0, count)]);
      const index = data.indexOf(FUSE_SENTINEL);
      if (index >= 0) return position - carry.length + index;
      carry = data.subarray(Math.max(0, data.length - overlapSize));
      position += count;
    }
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readElectronFuseWire(fsImpl, frameworkPath) {
  const sentinelOffset = findFuseSentinel(fsImpl, frameworkPath);
  if (sentinelOffset < 0) throw new Error('electron_fuse_sentinel_missing');
  const fd = fsImpl.openSync(frameworkPath, 'r');
  try {
    const prefixOffset = sentinelOffset + FUSE_SENTINEL.length;
    const prefix = readExact(fsImpl, fd, Buffer.alloc(2), prefixOffset);
    const version = prefix[0];
    const length = prefix[1];
    if (version !== 1 || length <= EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX || length > 64) {
      throw new Error('unsupported_electron_fuse_wire');
    }
    const wire = readExact(fsImpl, fd, Buffer.alloc(length), prefixOffset + 2).toString('ascii');
    if (!/^[01r]+$/.test(wire)) throw new Error('invalid_electron_fuse_wire');
    return { version, wire };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function containsValue(value, target) {
  if (typeof value === 'string') return value === target;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, target));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsValue(item, target));
  }
  return false;
}

function buildBootstrapSource() {
  return 'import{createRequire as r}from"node:module";'
    + `const p=process.env.${AIH_ZCODE_CAPTCHA_HOOK_MODULE_ENV};`
    + 'if(!p)throw new Error("aih_zcode_captcha_hook_path_missing");'
    + 'r(import.meta.url)(p);'
    + 'await import("../../out/main/index.js");\n';
}

function padEntry(content, size) {
  const source = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (source.length > size) throw new Error('asar_patch_entry_too_small');
  const output = Buffer.alloc(size, 0x20);
  source.copy(output);
  if (output.length > source.length) output[output.length - 1] = 0x0a;
  return output;
}

function inspectSourceBundle(options) {
  const { fs: fsImpl, path: pathImpl, sourceBundlePath, hookModulePath } = options;
  if (!sourceBundlePath || !fsImpl.existsSync(sourceBundlePath)) {
    throw new Error('zcode_source_bundle_missing');
  }
  if (!hookModulePath || !fsImpl.existsSync(hookModulePath)) {
    throw new Error('zcode_captcha_hook_module_missing');
  }
  const resourcesPath = pathImpl.join(sourceBundlePath, 'Contents', 'Resources');
  const asarPath = pathImpl.join(resourcesPath, 'app.asar');
  const frameworkPath = pathImpl.join(
    sourceBundlePath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  );
  const fuse = readElectronFuseWire(fsImpl, frameworkPath);
  if (fuse.wire[EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX] !== '0') {
    return failure('zcode_captcha_shadow_integrity_enabled');
  }
  const metadata = readAsarMetadata(fsImpl, asarPath);
  const packageEntry = readAsarEntry(fsImpl, asarPath, metadata, 'package.json');
  const yamlPackageEntry = readAsarEntry(fsImpl, asarPath, metadata, YAML_PACKAGE_PATH);
  const bootstrapEntry = readAsarEntry(fsImpl, asarPath, metadata, BOOTSTRAP_ENTRY_PATH);
  const originalMainEntry = readAsarEntry(fsImpl, asarPath, metadata, ORIGINAL_MAIN_PATH);
  for (const [entryPath, item] of [
    ['package.json', packageEntry],
    [YAML_PACKAGE_PATH, yamlPackageEntry],
    [BOOTSTRAP_ENTRY_PATH, bootstrapEntry],
    [ORIGINAL_MAIN_PATH, originalMainEntry]
  ]) {
    assertEntryIntegrity(entryPath, item.entry, item.content);
  }
  const packageJson = JSON.parse(packageEntry.content.toString('utf8'));
  if (packageJson.type !== 'module' || packageJson.main !== ORIGINAL_MAIN_PATH) {
    throw new Error('unsupported_zcode_package_main');
  }
  const yamlPackage = JSON.parse(yamlPackageEntry.content.toString('utf8'));
  if (!containsValue(yamlPackage.bin, './bin.mjs')
    || containsValue(yamlPackage.exports, './bin.mjs')) {
    throw new Error('unsafe_zcode_bootstrap_entry');
  }
  const bootstrapSource = buildBootstrapSource();
  if (Buffer.byteLength(bootstrapSource) > bootstrapEntry.entry.size) {
    throw new Error('zcode_bootstrap_entry_too_small');
  }
  const sourceExecutablePath = String(options.sourceExecutablePath || '').trim()
    || pathImpl.join(sourceBundlePath, 'Contents', 'MacOS', 'ZCode');
  const executableRelativePath = pathImpl.relative(sourceBundlePath, sourceExecutablePath);
  if (!executableRelativePath || executableRelativePath.startsWith('..')
    || pathImpl.isAbsolute(executableRelativePath)) {
    throw new Error('invalid_zcode_executable_path');
  }
  const hookHash = sha256(fsImpl.readFileSync(hookModulePath));
  const fingerprint = sha256(JSON.stringify({
    version: SHADOW_LAYOUT_VERSION,
    headerHash: metadata.headerHash,
    packageHash: packageEntry.entry.integrity.hash,
    bootstrapHash: bootstrapEntry.entry.integrity.hash,
    mainHash: originalMainEntry.entry.integrity.hash,
    fuseWire: fuse.wire,
    hookHash,
    executableRelativePath
  })).slice(0, 16);
  return {
    ready: true,
    asarPath,
    bootstrapSource,
    executableRelativePath,
    fingerprint,
    hookHash,
    metadata,
    packageEntry,
    packageJson
  };
}

function patchShadowAsar(fsImpl, shadowAsarPath, source) {
  const metadata = readAsarMetadata(fsImpl, shadowAsarPath);
  if (metadata.headerHash !== source.metadata.headerHash) {
    throw new Error('shadow_asar_header_changed');
  }
  const packageEntry = resolveAsarEntry(metadata, 'package.json');
  const bootstrapEntry = resolveAsarEntry(metadata, BOOTSTRAP_ENTRY_PATH);
  const patchedPackage = padEntry(JSON.stringify({
    ...source.packageJson,
    main: BOOTSTRAP_ENTRY_PATH
  }), packageEntry.size);
  const patchedBootstrap = padEntry(source.bootstrapSource, bootstrapEntry.size);
  const fd = fsImpl.openSync(shadowAsarPath, 'r+');
  try {
    writeExact(fsImpl, fd, patchedPackage, packageEntry.absoluteOffset);
    writeExact(fsImpl, fd, patchedBootstrap, bootstrapEntry.absoluteOffset);
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function verifyShadowAsar(fsImpl, shadowAsarPath, source) {
  const metadata = readAsarMetadata(fsImpl, shadowAsarPath);
  if (metadata.headerHash !== source.metadata.headerHash) return false;
  const packageEntry = readAsarEntry(fsImpl, shadowAsarPath, metadata, 'package.json');
  const bootstrapEntry = readAsarEntry(fsImpl, shadowAsarPath, metadata, BOOTSTRAP_ENTRY_PATH);
  try {
    const packageJson = JSON.parse(packageEntry.content.toString('utf8'));
    return packageJson.main === BOOTSTRAP_ENTRY_PATH
      && bootstrapEntry.content.toString('utf8').startsWith(source.bootstrapSource);
  } catch (_error) {
    return false;
  }
}

function defaultCloneBundle(source, target, execFileSyncImpl) {
  execFileSyncImpl('/bin/cp', ['-c', '-R', source, target], { stdio: 'pipe' });
}

function defaultSignBundle(bundlePath, execFileSyncImpl) {
  execFileSyncImpl('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    // app.asar 只属于外层 App 的资源封印；内部 Helper/Framework 未修改，保留其
    // 原 Developer ID 签名即可。对整包 --deep 重签会让当前 Electron Framework
    // 触发 codesign internal error，也会无谓扩大变更面。
    '--preserve-metadata=entitlements,flags,runtime',
    bundlePath
  ], { stdio: 'pipe' });
}

function defaultVerifyBundle(bundlePath, execFileSyncImpl) {
  execFileSyncImpl('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    bundlePath
  ], { stdio: 'pipe' });
  return true;
}

function readMarker(fsImpl, markerPath) {
  try {
    return JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeMarker(fsImpl, markerPath, marker) {
  fsImpl.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function prepareZcodeElectronShadowApp(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const execFileSyncImpl = options.execFileSync || nodeExecFileSync;
  const sourceBundlePath = String(options.sourceBundlePath || '').trim();
  const profileDir = String(options.profileDir || '').trim();
  const hookModulePath = String(options.hookModulePath || '').trim();
  if (!profileDir) return failure('zcode_captcha_shadow_profile_missing');

  let source;
  try {
    source = inspectSourceBundle({
      fs: fsImpl,
      path: pathImpl,
      sourceBundlePath,
      sourceExecutablePath: options.sourceExecutablePath,
      hookModulePath
    });
  } catch (error) {
    return failure(
      'zcode_captcha_shadow_unsupported_bundle',
      String((error && error.message) || error || 'unknown')
    );
  }
  if (!source.ready) return source;

  const shadowRoot = pathImpl.join(profileDir, '.aih-runtime', 'zcode-shadow');
  const finalRoot = pathImpl.join(shadowRoot, source.fingerprint);
  const finalBundlePath = pathImpl.join(finalRoot, 'ZCode.app');
  const finalExecutablePath = pathImpl.join(finalBundlePath, source.executableRelativePath);
  const finalAsarPath = pathImpl.join(finalBundlePath, 'Contents', 'Resources', 'app.asar');
  const markerPath = pathImpl.join(finalRoot, 'manifest.json');
  const cloneBundle = typeof options.cloneBundle === 'function'
    ? options.cloneBundle
    : (from, to) => defaultCloneBundle(from, to, execFileSyncImpl);
  const signBundle = typeof options.signBundle === 'function'
    ? options.signBundle
    : (bundlePath) => defaultSignBundle(bundlePath, execFileSyncImpl);
  const verifyBundle = typeof options.verifyBundle === 'function'
    ? options.verifyBundle
    : (bundlePath) => defaultVerifyBundle(bundlePath, execFileSyncImpl);

  const marker = readMarker(fsImpl, markerPath);
  if (marker && marker.version === SHADOW_LAYOUT_VERSION
    && marker.fingerprint === source.fingerprint
    && marker.headerHash === source.metadata.headerHash
    && marker.hookHash === source.hookHash
    && fsImpl.existsSync(finalExecutablePath)
    && fsImpl.existsSync(finalAsarPath)
    && verifyShadowAsar(fsImpl, finalAsarPath, source)) {
    try {
      if (verifyBundle(finalBundlePath) !== false) {
        return {
          ready: true,
          status: 'reused',
          resolved: { bundlePath: finalBundlePath, executablePath: finalExecutablePath }
        };
      }
    } catch (_error) {}
  }

  fsImpl.mkdirSync(shadowRoot, { recursive: true, mode: 0o700 });
  if (fsImpl.existsSync(finalRoot)) {
    const ownedPrefix = `${pathImpl.resolve(shadowRoot)}${pathImpl.sep}`;
    if (!pathImpl.resolve(finalRoot).startsWith(ownedPrefix)) {
      return failure('zcode_captcha_shadow_path_invalid');
    }
    fsImpl.rmSync(finalRoot, { recursive: true, force: true });
  }
  const tempRoot = fsImpl.mkdtempSync(pathImpl.join(shadowRoot, `.prepare-${source.fingerprint}-`));
  const tempBundlePath = pathImpl.join(tempRoot, 'ZCode.app');
  const tempAsarPath = pathImpl.join(tempBundlePath, 'Contents', 'Resources', 'app.asar');
  try {
    cloneBundle(sourceBundlePath, tempBundlePath);
    patchShadowAsar(fsImpl, tempAsarPath, source);
    if (!verifyShadowAsar(fsImpl, tempAsarPath, source)) {
      throw new Error('zcode_shadow_asar_verify_failed');
    }
    signBundle(tempBundlePath);
    if (verifyBundle(tempBundlePath) === false) throw new Error('zcode_shadow_signature_invalid');
    writeMarker(fsImpl, pathImpl.join(tempRoot, 'manifest.json'), {
      version: SHADOW_LAYOUT_VERSION,
      fingerprint: source.fingerprint,
      headerHash: source.metadata.headerHash,
      hookHash: source.hookHash,
      originalMain: ORIGINAL_MAIN_PATH,
      bootstrapEntry: BOOTSTRAP_ENTRY_PATH
    });
    fsImpl.renameSync(tempRoot, finalRoot);
    return {
      ready: true,
      status: 'prepared',
      resolved: { bundlePath: finalBundlePath, executablePath: finalExecutablePath }
    };
  } catch (error) {
    try {
      fsImpl.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_cleanupError) {}
    return failure(
      'zcode_captcha_shadow_prepare_failed',
      String((error && error.message) || error || 'unknown')
    );
  }
}

module.exports = {
  AIH_ZCODE_CAPTCHA_HOOK_MODULE_ENV,
  BOOTSTRAP_ENTRY_PATH,
  EMBEDDED_ASAR_INTEGRITY_FUSE_INDEX,
  ORIGINAL_MAIN_PATH,
  buildBootstrapSource,
  prepareZcodeElectronShadowApp,
  readAsarMetadata,
  readElectronFuseWire
};
