'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isWindows, nodeDistributionFile } = require('./targets');
const { copyTree, ensureDir, readJson, removeIfExists, sha256File, writeJson } = require('./fs-utils');

const NODE_DIST_BASE = 'https://nodejs.org/dist';
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'aih-packager');

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

function runtimeNodeBinary(root, platform = process.platform) {
  return platform === 'win32'
    ? path.join(root, 'node.exe')
    : path.join(root, 'bin', 'node');
}

function isRunnableHere(target) {
  return target.platform === process.platform && target.arch === process.arch;
}

function sevenZipPath() {
  try {
    return require('7zip-bin').path7za;
  } catch (_error) {
    return '';
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result;
}

async function fetchWithRetry(url, options = {}) {
  const retries = Number(options.retries) || 4;
  const timeoutMs = Number(options.timeoutMs) || 120000;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
  throw new Error(`download failed: ${url}: ${lastError && lastError.message}`);
}

async function writeResponseToFile(response, destination) {
  const handle = await fs.promises.open(destination, 'w');
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

function parseShasums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

function extractArchive(archive, destination) {
  ensureDir(destination);
  if (archive.endsWith('.zip')) {
    const sevenZip = sevenZipPath();
    if (!sevenZip) throw new Error('7za is required to extract a Node zip runtime');
    run(sevenZip, ['x', archive, `-o${destination}`, '-y']);
    return;
  }
  try {
    run('tar', ['-xzf', archive, '-C', destination]);
  } catch (error) {
    const sevenZip = sevenZipPath();
    if (!sevenZip) throw error;
    run(sevenZip, ['x', archive, `-o${destination}`, '-y']);
    const uncompressed = fs.readdirSync(destination).map((name) => path.join(destination, name));
    const tarFile = uncompressed.find((candidate) => candidate.endsWith('.tar'));
    if (tarFile) {
      run(sevenZip, ['x', tarFile, `-o${destination}`, '-y']);
      fs.rmSync(tarFile, { force: true });
    }
  }
}

function writeNpmWrapper(filePath, scriptRelativePath) {
  const body = `#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$DIR/node" "$DIR/../${scriptRelativePath}" "$@"\n`;
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function pruneRuntime(root, target) {
  for (const name of ['include', 'share', 'CHANGELOG.md', 'CHANGELOG_V8.md']) {
    removeIfExists(path.join(root, name));
  }
  if (isWindows(target)) {
    // 官方 Windows 发行包是扁平的；宿主复制时可能带全局 CLI，只保留 npm/corepack。
    const modules = path.join(root, 'node_modules');
    if (fs.existsSync(modules)) {
      for (const name of fs.readdirSync(modules)) {
        if (name !== 'npm' && name !== 'corepack') removeIfExists(path.join(modules, name));
      }
    }
    return;
  }

  // 只保留运行 npm 需要的部分。nvm 的 node 根目录里可能有整套全局 CLI，
  // 直接复制会让运行时膨胀到 1GB+。
  const binDir = path.join(root, 'bin');
  for (const name of fs.readdirSync(binDir)) {
    if (name !== 'node') removeIfExists(path.join(binDir, name));
  }
  const npmCli = path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error(`npm is missing from the Node runtime: ${npmCli}`);
  // 不用符号链接：zip 载荷和跨平台解包对链接的支持不一致，wrapper 在所有路径下都成立。
  writeNpmWrapper(path.join(binDir, 'npm'), 'lib/node_modules/npm/bin/npm-cli.js');
  writeNpmWrapper(path.join(binDir, 'npx'), 'lib/node_modules/npm/bin/npx-cli.js');

  const modules = path.join(root, 'lib', 'node_modules');
  if (fs.existsSync(modules)) {
    for (const name of fs.readdirSync(modules)) {
      if (name !== 'npm') removeIfExists(path.join(modules, name));
    }
  }
}

function findRuntimeRoot(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 1) return path.join(directory, entries[0].name);
  return directory;
}

function verifyRuntime(root, target = { platform: process.platform, arch: process.arch }) {
  const node = runtimeNodeBinary(root, target.platform);
  if (!fs.existsSync(node)) throw new Error(`node runtime is missing: ${node}`);
  // 交叉打包时不能执行目标平台的 node（会 ENOEXEC/Bad CPU type），只做存在性检查。
  if (!isRunnableHere(target)) return { binary: node, version: '' };
  const result = run(node, ['--version']);
  return { binary: node, version: String(result.stdout || '').trim() };
}

/**
 * 解析一份可直接随包分发的 Node 运行时（含 npm）。
 * - 目标与宿主一致且版本匹配：直接复用当前 Node 安装，避免重复下载；
 * - 其它情况：从 nodejs.org 下载官方发行包，按 SHASUMS256.txt 校验后缓存解包。
 */
async function ensureNodeRuntime(options = {}) {
  const target = options.target;
  if (!target) throw new Error('ensureNodeRuntime requires a target');
  const version = normalizeVersion(options.version || process.versions.node);
  const cacheDir = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  const log = options.log || (() => {});
  const override = options.runtimeDir ? path.resolve(options.runtimeDir) : '';

  if (override) {
    const verified = verifyRuntime(override, target);
    return { root: override, version: verified.version.replace(/^v/, '') || version, source: 'override', cacheHit: true };
  }

  if (target.platform === process.platform && target.arch === process.arch && normalizeVersion(process.versions.node) === version) {
    const root = path.dirname(path.dirname(process.execPath));
    try {
      const verified = verifyRuntime(root, target);
      return { root, version: verified.version.replace(/^v/, '') || version, source: 'host', cacheHit: true };
    } catch (_error) {
      // 有些安装只带 node 可执行文件；继续走下载路径拿到完整发行包。
    }
  }

  const distDir = path.join(cacheDir, 'node', `v${version}`, target.nodeDist);
  const markerFile = path.join(distDir, '.aih-runtime.json');
  if (fs.existsSync(markerFile)) {
    try {
      const marker = readJson(markerFile);
      const verified = verifyRuntime(distDir, target);
      if (marker.version === version && marker.dist === target.nodeDist) {
        return { root: distDir, version: verified.version.replace(/^v/, '') || marker.version, source: 'cache', cacheHit: true };
      }
    } catch (_error) {
      removeIfExists(distDir);
    }
  }

  const fileName = nodeDistributionFile(target, version);
  const artifactDir = path.join(cacheDir, 'artifacts');
  ensureDir(artifactDir);
  const archive = path.join(artifactDir, fileName);
  ensureDir(path.dirname(distDir));

  const shasums = parseShasums(await (await fetchWithRetry(`${NODE_DIST_BASE}/v${version}/SHASUMS256.txt`, { timeoutMs: 60000 })).text());
  const expected = shasums.get(fileName);
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${fileName}`);

  let validCached = false;
  if (fs.existsSync(archive)) {
    validCached = sha256File(archive) === expected;
  }
  if (!validCached) {
    log(`[pkg] downloading Node ${version} (${fileName})`);
    const response = await fetchWithRetry(`${NODE_DIST_BASE}/v${version}/${fileName}`);
    const temporary = `${archive}.download-${process.pid}`;
    await writeResponseToFile(response, temporary);
    const actual = sha256File(temporary);
    if (actual !== expected) {
      removeIfExists(temporary);
      throw new Error(`Node runtime checksum mismatch for ${fileName}: ${actual} != ${expected}`);
    }
    fs.renameSync(temporary, archive);
  }

  const staging = path.join(cacheDir, 'unpack', `${fileName}.${process.pid}`);
  removeIfExists(staging);
  ensureDir(staging);
  try {
    log(`[pkg] extracting Node ${version} (${target.nodeDist})`);
    extractArchive(archive, staging);
    const extractedRoot = findRuntimeRoot(staging);
    removeIfExists(distDir);
    fs.renameSync(extractedRoot, distDir);
  } finally {
    removeIfExists(staging);
  }
  pruneRuntime(distDir, target);
  const verified = verifyRuntime(distDir, target);
  writeJson(markerFile, {
    version,
    dist: target.nodeDist,
    archive: fileName,
    sha256: expected,
    node: verified.version || `v${version}`
  });
  return { root: distDir, version: verified.version.replace(/^v/, '') || version, source: 'download', cacheHit: false };
}

/** 把运行时复制进 bundle 的 runtime/ 目录（保留可执行位）。 */
function copyRuntimeIntoBundle(runtimeRoot, bundleRoot, target) {
  const destination = path.join(bundleRoot, 'runtime');
  removeIfExists(destination);
  ensureDir(destination);
  copyTree(runtimeRoot, destination, { dereference: true });
  pruneRuntime(destination, target);
  removeIfExists(path.join(destination, '.aih-runtime.json'));
  const node = path.join(destination, isWindows(target) ? 'node.exe' : path.join('bin', 'node'));
  if (!fs.existsSync(node)) throw new Error(`copied runtime is missing node: ${node}`);
  if (!isWindows(target)) fs.chmodSync(node, 0o755);
  return destination;
}

module.exports = {
  DEFAULT_CACHE_DIR,
  copyRuntimeIntoBundle,
  ensureNodeRuntime,
  extractArchive,
  fetchWithRetry,
  normalizeVersion,
  parseShasums,
  pruneRuntime,
  runtimeNodeBinary,
  verifyRuntime
};
