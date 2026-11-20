'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { artifactBaseName, isWindows, targetKey } = require('./targets');
const { copyTree, ensureDir, readJson, removeIfExists, sha256Tree, writeJson } = require('./fs-utils');

// 仅分发正式运行时目录；examples 不属于产品内容。web/dist 单独处理。
const APP_DIRECTORIES = Object.freeze([
  'bin',
  'lib',
  'assets',
  'contracts',
  'scripts',
  'native'
]);

const POSIX_LAUNCHER = `#!/bin/sh
# AI Home 便携版启动器。不要移动 runtime/ 或 bin/，它们与本文件同目录。
set -e

SELF=$0
while [ -h "$SELF" ]; do
  DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd -P)
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF=$LINK ;;
    *) SELF=$DIR/$LINK ;;
  esac
done
DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd -P)

# CLI 入口是 Go 原生实现；Node 运行时只留给 codex hooks / DSH 等外部运行时，
# 缺失时 CLI 仍可用，因此这里不再硬失败。
if [ -d "$DIR/runtime/bin" ]; then
  PATH="$DIR/runtime/bin:$PATH"
  export PATH
fi
AIH_PACKAGED=1
AIH_EXECUTABLE="$DIR/aih"
AIH_PACKAGE_ROOT="$DIR"
export AIH_PACKAGED AIH_EXECUTABLE AIH_PACKAGE_ROOT

exec "$DIR/bin/aih" "$@"
`;

// Platform effects stay in focused adapters, not in the bundle composition.
const POSIX_INSTALLER = fs.readFileSync(path.join(__dirname, 'installers', 'posix.sh'), 'utf8');
const POWERSHELL_INSTALLER = fs.readFileSync(path.join(__dirname, 'installers', 'windows.ps1'), 'utf8');

function readSourceSha(repositoryRoot) {
  // Exact archive builds have no .git directory. The caller pins the verified
  // commit explicitly; never publish an empty or inferred source provenance.
  const pinned = String(process.env.AIH_BUILD_SOURCE_SHA || '').trim();
  if (pinned) {
    if (!/^[0-9a-f]{40}$/.test(pinned)) throw new Error('AIH_BUILD_SOURCE_SHA must be an exact commit');
    return pinned;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function copyAppTree(repositoryRoot, bundleRoot) {
  for (const directory of APP_DIRECTORIES) {
    const source = path.join(repositoryRoot, directory);
    if (!fs.existsSync(source)) {
      throw new Error(`missing required runtime directory: ${directory}`);
    }
    const destination = path.join(bundleRoot, directory);
    if (directory === 'bin') {
      // bin/native 里是本机为其它目标构建的 Go 二进制；只能带当前目标那一份。
      ensureDir(destination);
      for (const name of fs.readdirSync(source)) {
        if (name === 'native' || name === '.DS_Store' || name.startsWith('._')) continue;
        copyTree(path.join(source, name), path.join(destination, name), { dereference: true });
      }
      continue;
    }
    copyTree(source, destination, { dereference: true });
  }
  const webDist = path.join(repositoryRoot, 'web', 'dist');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    throw new Error('web/dist is missing or incomplete; run `npm run web:build` first');
  }
  copyTree(webDist, path.join(bundleRoot, 'web', 'dist'), { dereference: true });
  for (const file of ['README.md', 'package.json']) {
    const source = path.join(repositoryRoot, file);
    if (fs.existsSync(source)) copyTree(source, path.join(bundleRoot, file));
  }
  // 分发包使用裁剪后的 package.json（不含 postinstall / 可选的大依赖）。
  const bundleManifest = readJson(path.join(bundleRoot, 'package.json'));
  if (bundleManifest.scripts) delete bundleManifest.scripts.postinstall;
  delete bundleManifest.dependencies?.['@openai/codex'];
  writeJson(path.join(bundleRoot, 'package.json'), bundleManifest);
}

function writePosixFiles(bundleRoot, version) {
  const launcher = path.join(bundleRoot, 'aih');
  fs.writeFileSync(launcher, POSIX_LAUNCHER, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  const installer = path.join(bundleRoot, 'install.sh');
  fs.writeFileSync(installer, POSIX_INSTALLER.replace('__AIH_VERSION__', version), { mode: 0o755 });
  fs.chmodSync(installer, 0o755);
}

function writePowerShellFile(bundleRoot, version) {
  fs.writeFileSync(
    path.join(bundleRoot, 'install.ps1'),
    '\uFEFF' + POWERSHELL_INSTALLER.replace('__AIH_VERSION__', version),
    'utf8'
  );
}

function writeBuildInfo(bundleRoot, info) {
  const buildInfo = {
    name: 'ai-home',
    version: info.version,
    target: targetKey(info.target),
    node: info.nodeVersion,
    built_at: new Date().toISOString(),
    source_sha: info.sourceSha || '',
    web: info.web || null,
    go_core: info.goCore || null,
    bundled_ui: true
  };
  writeJson(path.join(bundleRoot, 'BUILD_INFO.json'), buildInfo);
  fs.writeFileSync(path.join(bundleRoot, 'VERSION'), `${info.version}\n`);
  return buildInfo;
}

const { copyNativeComponents: copyGoCore } = require('./native-components');

function buildWindowsLauncher(options) {
  const { repositoryRoot, bundleRoot, target, log } = options;
  if (!isWindows(target)) return null;
  const sourceDir = path.join(__dirname, 'launcher');
  const output = path.join(bundleRoot, 'aih.exe');
  const args = [
    'build',
    '-trimpath',
    '-ldflags',
    '-s -w',
    '-o',
    output,
    '.'
  ];
  log(`[pkg] building Windows launcher for ${targetKey(target)}`);
  const result = spawnSync('go', args, {
    cwd: sourceDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Go launcher build failed with ${result.status}`);
  return output;
}

function removeBundleCaches(bundleRoot) {
  for (const name of ['.DS_Store', '._.DS_Store']) {
    removeIfExists(path.join(bundleRoot, name));
  }
}

/**
 * 组装一个可直接运行的便携版目录。
 * 调用方负责 node_modules / runtime 已经放入 bundleRoot。
 */
function finalizeBundle(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const bundleRoot = path.resolve(options.bundleRoot);
  const target = options.target;
  const version = options.version;
  const log = options.log || (() => {});
  ensureDir(bundleRoot);

  copyAppTree(repositoryRoot, bundleRoot);
  writePosixFiles(bundleRoot, version);
  writePowerShellFile(bundleRoot, version);
  buildWindowsLauncher({ repositoryRoot, bundleRoot, target, log });
  if (options.skipGo) throw new Error('native_components_required');
  const goCore = copyGoCore(repositoryRoot, bundleRoot, target);
  removeBundleCaches(bundleRoot);
  const webManifest = sha256Tree(path.join(bundleRoot, 'web', 'dist'));
  const info = writeBuildInfo(bundleRoot, {
    version,
    target,
    nodeVersion: options.nodeVersion,
    sourceSha: readSourceSha(repositoryRoot),
    web: { sha256: webManifest.sha256, files: webManifest.fileCount, bytes: webManifest.bytes },
    goCore
  });
  return { root: bundleRoot, buildInfo: info };
}

module.exports = {
  APP_DIRECTORIES,
  POSIX_INSTALLER,
  POSIX_LAUNCHER,
  POWERSHELL_INSTALLER,
  buildBundleName: artifactBaseName,
  copyAppTree,
  copyGoCore,
  finalizeBundle,
  readSourceSha,
  writeBuildInfo,
  writePosixFiles,
  writePowerShellFile
};
