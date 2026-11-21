'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureDir, readJson, removeIfExists, walkFiles, writeJson } = require('./fs-utils');

// 不随分发版携带的依赖：@openai/codex 只是本机开发时的 codex 恢复目标，
// 其平台包单个就有 200MB+；分发包由用户按需安装 codex CLI。
const EXCLUDED_PACKAGES = Object.freeze(['@openai/codex']);

// 分发包内 Node 只服务三处：node 插件宿主（cordis + 插件 SDK 的 ajv/semver）
// 与 opencode 插件钩子配置（fs-extra）。其余 Node 依赖属开发脚本，留在 devDependencies，
// 由 npm 的 --omit=dev 挡在包外，与 Go 服务端无关。
const REQUIRED_MODULES = Object.freeze([
  '@deepseek-ai/cordis',
  'ajv',
  'fs-extra',
  'semver'
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
  if (root) {
    for (const map of ['dependencies', 'devDependencies']) {
      if (!root[map]) continue;
      for (const name of excluded) delete root[map][name];
    }
  }
  for (const key of Object.keys(packages)) {
    if (isExcluded(key)) delete packages[key];
  }
  return lockfile;
}

/** 生成分发版 package.json / package-lock.json：去掉不随包携带的依赖与安装钩子。 */
function prepareManifest(repositoryRoot, staging) {
  const manifest = readJson(path.join(repositoryRoot, 'package.json'));
  for (const name of EXCLUDED_PACKAGES) {
    delete manifest.dependencies?.[name];
    delete manifest.devDependencies?.[name];
  }
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
    if (!fs.existsSync(packagePath(root, name))) missing.push(name);
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

function pruneModules(root) {
  removeIfExists(path.join(root, 'node_modules', '@openai'));
  // npm 生成的 .bin 全是符号链接；分发包不需要它们，zip 也不擅长表达符号链接。
  removeIfExists(path.join(root, 'node_modules', '.bin'));
  removeIfExists(path.join(root, 'node_modules', '.package-lock.json'));
  removeIfExists(path.join(root, 'node_modules', '.aih-cache'));

  // 调试符号与源码映射对运行没有价值。
  for (const file of walkFiles(path.join(root, 'node_modules'))) {
    if (file.endsWith('.pdb') || file.endsWith('.dSYM') || file.endsWith('.map')) {
      removeIfExists(file);
    }
  }
  chmodExecutables(path.join(root, 'node_modules'));
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
  pruneModules(staging);
  return path.join(staging, 'node_modules');
}

module.exports = {
  EXCLUDED_PACKAGES,
  NPM_FLAGS,
  REQUIRED_MODULES,
  prepareManifest,
  pruneLockfile,
  pruneModules,
  stageProductionModules,
  verifyRequiredModules
};
