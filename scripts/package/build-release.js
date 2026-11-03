#!/usr/bin/env node
'use strict';

/**
 * 构建可分发的 AI Home 安装包。
 *
 * 两种产物（每个平台各一份）：
 *   1. aih-<version>-<target>.run / .exe  单文件自解压启动器（Go + 内嵌 zip）
 *   2. aih-<version>-<target>.tar.gz/.zip  便携目录归档（解压即用）
 *
 * 分发包自带 Node 22 运行时（含 npm）、构建好的 WebUI 和生产依赖，
 * 目标机器不需要预装 Node。
 *
 * 用法：
 *   node scripts/package/build-release.js --targets host
 *   node scripts/package/build-release.js --targets all --build-web --with-go
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { TARGETS, artifactBaseName, isWindows, parseTargets, targetKey } = require('./targets');
const { ensureNodeRuntime, copyRuntimeIntoBundle, normalizeVersion } = require('./node-runtime');
const { stageProductionModules } = require('./modules');
const { finalizeBundle } = require('./bundle');
const { createTarGz, createZip, writeChecksum } = require('./archives');
const { buildSelfExtractingExecutable } = require('./sfx');
const { copyTree, ensureDir, removeIfExists, writeJson } = require('./fs-utils');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(REPOSITORY_ROOT, 'dist', 'release');

function usage() {
  console.log(`AI Home release builder

用法:
  node scripts/package/build-release.js [options]

选项:
  --targets <list>        host（默认）| all | darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64,win32-arm64
  --version <version>     包版本，默认 package.json
  --node-version <v>      内置 Node 版本，默认当前运行时
  --node-runtime-dir <d>  直接使用指定的 Node 运行时目录（仅单目标）
  --out <dir>             输出目录，默认 dist/release
  --build-web             强制构建 WebUI（默认只在 web/dist 缺失时构建）
  --skip-web-build        不构建 WebUI，直接使用现有 web/dist
  --npm-registry <url>    覆盖 npm registry（默认沿用 npm 配置；国内可用 https://registry.npmmirror.com）
  --with-go               一并构建并打包 Go Core（默认跳过）
  --skip-sfx              不生成单文件自解压产物
  --skip-archives         不生成 tar.gz / zip
  --keep-work             保留中间目录（便于排错）
  --list-targets          列出支持的目标
  -h, --help              显示帮助`);
}

function parseArgs(argv) {
  const options = {
    targets: 'host',
    version: '',
    nodeVersion: normalizeVersion(process.versions.node),
    out: DEFAULT_OUT,
    buildWeb: false,
    skipWebBuild: false,
    withGo: false,
    skipSfx: false,
    skipArchives: false,
    keepWork: false,
    nodeRuntimeDir: '',
    npmRegistry: process.env.AIH_PKG_NPM_REGISTRY || '',
    listTargets: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--targets') options.targets = next();
    else if (arg === '--version') options.version = next();
    else if (arg === '--node-version') options.nodeVersion = normalizeVersion(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--node-runtime-dir') options.nodeRuntimeDir = next();
    else if (arg === '--npm-registry') options.npmRegistry = next();
    else if (arg === '--build-web') options.buildWeb = true;
    else if (arg === '--skip-web-build') options.skipWebBuild = true;
    else if (arg === '--with-go') options.withGo = true;
    else if (arg === '--skip-sfx') options.skipSfx = true;
    else if (arg === '--skip-archives') options.skipArchives = true;
    else if (arg === '--keep-work') options.keepWork = true;
    else if (arg === '--list-targets') options.listTargets = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.buildWeb && options.skipWebBuild) throw new Error('--build-web and --skip-web-build are mutually exclusive');
  return options;
}

function readVersion(repositoryRoot) {
  return String(require(path.join(repositoryRoot, 'package.json')).version || '').trim();
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runWebBuild(repositoryRoot) {
  console.log('[pkg] building WebUI');
  const result = spawnSync(npmCommand(), ['run', 'web:build'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WebUI build failed with ${result.status}`);
}

function ensureWebDist(repositoryRoot, options) {
  const indexFile = path.join(repositoryRoot, 'web', 'dist', 'index.html');
  if (options.buildWeb) {
    runWebBuild(repositoryRoot);
  } else if (!fs.existsSync(indexFile)) {
    if (options.skipWebBuild) throw new Error('web/dist is missing and --skip-web-build was set');
    runWebBuild(repositoryRoot);
  }
  if (!fs.existsSync(indexFile)) throw new Error('web/dist/index.html is still missing after build');
}

function buildGoCore(repositoryRoot, target, log) {
  log(`[pkg] building Go Core for ${targetKey(target)}`);
  const { buildGoServer } = require('../build-go-server');
  return buildGoServer({ repositoryRoot, platform: target.platform, arch: target.arch, stdio: 'inherit' });
}

function formatSize(bytes) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MiB`;
}

async function buildTarget(options) {
  const { repositoryRoot, target, version, outRoot, workRoot, log } = options;
  const baseName = artifactBaseName(version, target);
  const targetWork = path.join(workRoot, targetKey(target));
  const bundleRoot = path.join(targetWork, baseName);
  removeIfExists(targetWork);
  ensureDir(bundleRoot);

  const runtime = await ensureNodeRuntime({
    target,
    version: options.nodeVersion,
    runtimeDir: options.nodeRuntimeDir,
    log
  });
  log(`[pkg] Node runtime ${runtime.version} (${runtime.source})`);
  copyRuntimeIntoBundle(runtime.root, bundleRoot, target);

  const modules = stageProductionModules({
    repositoryRoot,
    target,
    workDir: targetWork,
    cacheDir: path.join(targetWork, 'cache'),
    npmRegistry: options.npmRegistry,
    log
  });
  copyTree(modules, path.join(bundleRoot, 'node_modules'), { dereference: true });

  let goBuilt = false;
  if (options.withGo) {
    try {
      buildGoCore(repositoryRoot, target, log);
      goBuilt = true;
    } catch (error) {
      // Go Core 是可选的加速数据面，缺它时 Node 会接管全部路由。
      // 不让一个平台的交叉编译失败拖垮整批安装包。
      log(`[pkg] warning: Go Core build failed for ${targetKey(target)}: ${error.message}`);
    }
  }

  const finalized = finalizeBundle({
    repositoryRoot,
    bundleRoot,
    target,
    version,
    nodeVersion: runtime.version,
    skipGo: !goBuilt,
    log
  });
  log(`[pkg] bundle ready: ${finalized.root}`);

  const artifacts = [];
  if (!options.skipArchives) {
    if (isWindows(target)) {
      const zipPath = path.join(outRoot, `${baseName}.zip`);
      createZip(bundleRoot, zipPath);
      artifacts.push({ kind: 'archive', file: zipPath, ...writeChecksum(zipPath) });
    } else {
      const tarPath = path.join(outRoot, `${baseName}.tar.gz`);
      createTarGz(bundleRoot, tarPath);
      artifacts.push({ kind: 'archive', file: tarPath, ...writeChecksum(tarPath) });
    }
  }
  if (!options.skipSfx) {
    const sfxName = isWindows(target) ? `${baseName}.exe` : `${baseName}.run`;
    const sfxPath = path.join(outRoot, sfxName);
    const built = buildSelfExtractingExecutable({
      bundleRoot,
      workDir: targetWork,
      output: sfxPath,
      target,
      version,
      log
    });
    artifacts.push({ kind: 'single-file', file: sfxPath, ...writeChecksum(sfxPath) });
    log(`[pkg] single-file: ${path.relative(repositoryRoot, sfxPath)} (${formatSize(built.size)})`);
  }

  const bundleSize = artifacts.length ? null : null;
  void bundleSize;
  return { target, baseName, bundleRoot, artifacts, buildInfo: finalized.buildInfo };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  if (options.listTargets) {
    for (const target of TARGETS) console.log(`${targetKey(target).padEnd(16)} ${target.label}`);
    return 0;
  }

  const repositoryRoot = REPOSITORY_ROOT;
  const version = String(options.version || readVersion(repositoryRoot)).trim();
  if (!version) throw new Error('version is required');
  const targets = parseTargets(options.targets);
  if (options.nodeRuntimeDir && targets.length > 1) {
    throw new Error('--node-runtime-dir can only be used with a single target');
  }
  ensureWebDist(repositoryRoot, options);

  const outRoot = path.resolve(options.out);
  const workRoot = path.join(outRoot, '.work');
  ensureDir(outRoot);
  removeIfExists(workRoot);
  ensureDir(workRoot);

  console.log(`[pkg] ai-home ${version} -> ${targets.map(targetKey).join(', ')}`);
  const results = [];
  for (const target of targets) {
    const result = await buildTarget({
      repositoryRoot,
      target,
      version,
      nodeVersion: options.nodeVersion,
      nodeRuntimeDir: options.nodeRuntimeDir,
      npmRegistry: options.npmRegistry,
      outRoot,
      workRoot,
      withGo: options.withGo,
      skipSfx: options.skipSfx,
      skipArchives: options.skipArchives,
      log: (message) => console.log(message)
    });
    results.push(result);
    if (!options.keepWork) removeIfExists(path.join(workRoot, targetKey(target)));
  }

  const manifest = {
    name: 'ai-home',
    version,
    node: options.nodeVersion,
    built_at: new Date().toISOString(),
    targets: results.map((result) => ({
      target: targetKey(result.target),
      build: result.buildInfo,
      artifacts: result.artifacts.map((artifact) => ({
        kind: artifact.kind,
        file: path.basename(artifact.file),
        sha256: artifact.sha256,
        bytes: fs.statSync(artifact.file).size
      }))
    }))
  };
  writeJson(path.join(outRoot, `aih-${version}-manifest.json`), manifest);
  if (!options.keepWork) removeIfExists(workRoot);

  console.log('');
  for (const result of results) {
    for (const artifact of result.artifacts) {
      console.log(`${path.basename(artifact.file).padEnd(44)} ${formatSize(fs.statSync(artifact.file).size)}  ${artifact.sha256.slice(0, 16)}`);
    }
  }
  console.log(`\n[pkg] manifest: ${path.relative(repositoryRoot, path.join(outRoot, `aih-${version}-manifest.json`))}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`[pkg] ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  buildTarget,
  ensureWebDist,
  main,
  parseArgs,
  readVersion,
  usage
};
