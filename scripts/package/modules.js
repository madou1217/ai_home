'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isWindows } = require('./targets');
const { copyTree, ensureDir, readJson, removeIfExists, walkFiles, writeJson } = require('./fs-utils');

// 不随分发版携带的依赖：@openai/codex 只是本机开发时的 codex 恢复目标，
// 其平台包单个就有 200MB+；分发包由用户按需安装 codex CLI。
const EXCLUDED_PACKAGES = Object.freeze(['@openai/codex']);

const REQUIRED_MODULES = Object.freeze([
  '@deepseek-ai/cordis',
  '@opencode-ai/models/snapshot',
  'ajv',
  'fs-extra',
  'jsonc-parser',
  'maxmind',
  'mmdb-lib',
  'readline-sync',
  'semver',
  'smol-toml',
  'ssh2',
  'undici',
  'ws',
  'yaml'
]);

const NPM_FLAGS = Object.freeze([
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--maxsockets=4',
  '--fetch-timeout=60000',
  '--fetch-retries=3',
  '--fetch-retry-maxtimeout=20000'
]);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packagePath(root, name) {
  return path.join(root, 'node_modules', ...name.split('/'));
}

function pruneLockfile(lockfile, excluded = EXCLUDED_PACKAGES) {
  const packages = lockfile.packages || {};
  const isExcluded = (key) => excluded.some((name) => {
    const base = `node_modules/${name}`;
    // 同时覆盖包本身、它的子路径，以及 @openai/codex-<platform> 这类平台包。
    return key === base || key.startsWith(`${base}/`) || key.startsWith(`${base}-`);
  });
  const root = packages[''];
  if (root && root.dependencies) {
    for (const name of excluded) delete root.dependencies[name];
  }
  for (const key of Object.keys(packages)) {
    if (isExcluded(key)) delete packages[key];
  }
  return lockfile;
}

/** 生成分发版 package.json / package-lock.json：去掉不随包携带的依赖与安装钩子。 */
function prepareManifest(repositoryRoot, staging) {
  const manifest = readJson(path.join(repositoryRoot, 'package.json'));
  for (const name of EXCLUDED_PACKAGES) delete manifest.dependencies?.[name];
  if (manifest.scripts) delete manifest.scripts.postinstall;
  writeJson(path.join(staging, 'package.json'), manifest);

  const lockPath = path.join(repositoryRoot, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lockfile = pruneLockfile(readJson(lockPath));
    writeJson(path.join(staging, 'package-lock.json'), lockfile);
    return { manifest, hasLockfile: true };
  }
  return { manifest, hasLockfile: false };
}

function runNpm(staging, args, options = {}) {
  const result = spawnSync(npmCommand(), args, {
    cwd: staging,
    env: { ...process.env, npm_config_loglevel: 'warn', npm_config_fund: 'false', npm_config_audit: 'false' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: Number(options.timeoutMs) || 20 * 60 * 1000
  });
  if (result.error) throw result.error;
  return result.status;
}

function installModules(staging, target, options = {}) {
  const baseArgs = [
    ...NPM_FLAGS,
    `--os=${target.platform}`,
    `--cpu=${target.arch}`
  ];
  const registry = String(options.npmRegistry || process.env.AIH_PKG_NPM_REGISTRY || '').trim();
  if (registry) {
    baseArgs.push(`--registry=${registry}`, '--replace-registry-host=always');
  }
  if (options.hasLockfile) {
    const ciStatus = runNpm(staging, ['ci', ...baseArgs], options);
    if (ciStatus === 0) return;
    // 仓库的 package-lock 不随源码分发，本机可能已经过期（例如新增了直接依赖）。
    // 此时 npm ci 会直接拒绝，退回 npm install 重新解析，而不是让打包失败。
    console.warn('[pkg] npm ci rejected the lockfile; falling back to npm install');
    removeIfExists(path.join(staging, 'node_modules'));
  }
  const status = runNpm(staging, ['install', ...baseArgs], options);
  if (status !== 0) throw new Error(`npm install failed with ${status}`);
}

function verifyRequiredModules(root) {
  const missing = [];
  for (const name of REQUIRED_MODULES) {
    try {
      if (name.includes('/snapshot')) {
        require.resolve(name, { paths: [root] });
      } else if (!fs.existsSync(packagePath(root, name))) {
        missing.push(name);
      }
    } catch (_error) {
      missing.push(name);
    }
  }
  if (missing.length > 0) throw new Error(`production modules missing: ${missing.join(', ')}`);
}

function chmodExecutables(root) {
  for (const file of walkFiles(root)) {
    const name = path.basename(file);
    if (name === 'spawn-helper' || name === '7za' || name.endsWith('.exe')) {
      try {
        fs.chmodSync(file, 0o755);
      } catch (_error) { /* 只影响可执行位，复制到不支持 chmod 的介质时忽略 */ }
    }
  }
}

function pruneModules(root, target) {
  removeIfExists(path.join(root, 'node_modules', '@openai'));
  // npm 生成的 .bin 全是符号链接；分发包不需要它们，zip 也不擅长表达符号链接。
  removeIfExists(path.join(root, 'node_modules', '.bin'));
  removeIfExists(path.join(root, 'node_modules', '.package-lock.json'));
  removeIfExists(path.join(root, 'node_modules', '.aih-cache'));

  // 只保留目标平台的 @lydell/node-pty-*。这个包按平台拆成 optionalDependencies，
  // 交叉安装时 npm 可能把多个平台都拉下来。
  const lydellRoot = path.join(root, 'node_modules', '@lydell');
  if (fs.existsSync(lydellRoot)) {
    const expected = `node-pty-${target.platform}-${target.arch}`;
    for (const name of fs.readdirSync(lydellRoot)) {
      if (name.startsWith('node-pty-') && name !== expected) removeIfExists(path.join(lydellRoot, name));
    }
  }

  const sevenZipRoot = path.join(root, 'node_modules', '7zip-bin');
  if (fs.existsSync(sevenZipRoot)) {
    const keep = isWindows(target) ? 'win' : (target.platform === 'darwin' ? 'mac' : 'linux');
    for (const name of fs.readdirSync(sevenZipRoot)) {
      if (['win', 'mac', 'linux'].includes(name) && name !== keep) removeIfExists(path.join(sevenZipRoot, name));
    }
  }

  const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    const expected = `${target.platform}-${target.arch}`;
    for (const name of fs.readdirSync(prebuilds)) {
      if (name !== expected) removeIfExists(path.join(prebuilds, name));
    }
  }
  for (const name of ['deps', 'src', 'third_party', 'scripts', 'binding.gyp']) {
    removeIfExists(path.join(root, 'node_modules', 'node-pty', name));
  }

  // 调试符号与源码映射对运行没有价值，Windows 的 pty.pdb 单个就有十几 MB。
  for (const file of walkFiles(path.join(root, 'node_modules'))) {
    if (file.endsWith('.pdb') || file.endsWith('.dSYM') || file.endsWith('.map')) {
      removeIfExists(file);
    }
  }
  chmodExecutables(path.join(root, 'node_modules'));
}

function ptyPlatformPackageName(target) {
  return `@lydell/node-pty-${target.platform}-${target.arch}`;
}

function ensurePtyPlatformPackage(root, target, options = {}) {
  const packageName = ptyPlatformPackageName(target);
  const destination = packagePath(root, packageName);
  if (fs.existsSync(destination)) return { ok: true, source: 'npm' };

  // npm 的 --os/--cpu 覆盖在部分版本上不会重新解析 optionalDependencies；
  // 直接按 @lydell/node-pty 声明的版本下载平台包，避免整次安装失败。
  const hostPackage = readJson(path.join(root, 'node_modules', '@lydell', 'node-pty', 'package.json'));
  const version = hostPackage?.optionalDependencies?.[packageName];
  if (!version) throw new Error(`@lydell/node-pty does not declare ${packageName}`);
  const tarball = `https://registry.npmjs.org/${packageName}/-/${packageName.split('/').pop()}-${version}.tgz`;
  const cacheDir = options.cacheDir || path.join(root, '.aih-cache');
  ensureDir(cacheDir);
  const archive = path.join(cacheDir, `${packageName.split('/').pop()}-${version}.tgz`);
  if (!fs.existsSync(archive)) {
    const result = spawnSync('curl', ['-fsSL', '--retry', '3', '--max-time', '120', '-o', archive, tarball], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`failed to download ${tarball}`);
  }
  const staging = `${destination}.extract-${process.pid}`;
  removeIfExists(staging);
  ensureDir(staging);
  const sevenZip = require('7zip-bin').path7za;
  const result = spawnSync(sevenZip, ['x', archive, `-o${staging}`, '-y'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`failed to extract ${archive}`);
  ensureDir(path.dirname(destination));
  fs.renameSync(path.join(staging, 'package'), destination);
  removeIfExists(staging);
  removeIfExists(archive);
  return { ok: true, source: 'download' };
}

function verifyPty(root, target) {
  const packageName = ptyPlatformPackageName(target);
  if (!fs.existsSync(packagePath(root, packageName))) {
    const installed = fs.existsSync(path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${target.platform}-${target.arch}`));
    if (!installed) throw new Error(`no PTY prebuild for ${target.platform}-${target.arch}`);
  }
}

/**
 * 为单个目标平台准备生产依赖树。返回 node_modules 路径。
 */
function stageProductionModules(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..', '..'));
  const target = options.target;
  const workDir = path.resolve(options.workDir);
  const log = options.log || (() => {});
  const staging = path.join(workDir, 'node_modules-staging');
  removeIfExists(staging);
  ensureDir(staging);

  const { hasLockfile } = prepareManifest(repositoryRoot, staging);
  log(`[pkg] installing production modules for ${target.platform}-${target.arch}${hasLockfile ? ' (npm ci)' : ' (npm install)'}`);
  installModules(staging, target, { ...options, hasLockfile });
  verifyRequiredModules(staging);
  ensurePtyPlatformPackage(staging, target, options);
  pruneModules(staging, target);
  verifyPty(staging, target);
  return path.join(staging, 'node_modules');
}

module.exports = {
  EXCLUDED_PACKAGES,
  NPM_FLAGS,
  REQUIRED_MODULES,
  ensurePtyPlatformPackage,
  prepareManifest,
  pruneLockfile,
  pruneModules,
  stageProductionModules,
  verifyPty,
  verifyRequiredModules
};
