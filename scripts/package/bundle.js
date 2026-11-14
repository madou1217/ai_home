'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { artifactBaseName, isWindows, targetKey } = require('./targets');
const { copyTree, ensureDir, readJson, removeIfExists, sha256Tree, writeJson } = require('./fs-utils');

// 运行时依赖的仓库内目录（不是文档）。web/dist 单独处理，因为它可能来自预构建产物。
const APP_DIRECTORIES = Object.freeze([
  'bin',
  'lib',
  'assets',
  'contracts',
  'examples',
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

NODE="$DIR/runtime/bin/node"
if [ ! -x "$NODE" ]; then
  echo "[aih] 运行时缺失：$NODE（请重新解压完整安装包）" >&2
  exit 1
fi

PATH="$DIR/runtime/bin:$PATH"
export PATH
AIH_PACKAGED=1
AIH_EXECUTABLE="$DIR/aih"
export AIH_PACKAGED AIH_EXECUTABLE

exec "$NODE" "$DIR/bin/ai-home.js" "$@"
`;

const POSIX_INSTALLER = `#!/bin/sh
# 把这份便携版安装到用户目录，并在 PATH 里放一个 aih 链接。
set -e

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VERSION="__AIH_VERSION__"
DATA_HOME=\${XDG_DATA_HOME:-$HOME/.local/share}
INSTALL_DIR=\${AIH_INSTALL_DIR:-$DATA_HOME/aih}
BIN_DIR=\${AIH_BIN_DIR:-$HOME/.local/bin}
NO_PATH=0

usage() {
  cat <<'EOF'
用法: ./install.sh [选项]

  --prefix DIR    安装目录（默认 $XDG_DATA_HOME/aih 或 ~/.local/share/aih）
  --bin-dir DIR   放 aih 链接的目录（默认 ~/.local/bin）
  --no-path       不提示 PATH 配置
  --uninstall     卸载：删除链接和安装目录
  -h, --help      显示帮助
EOF
}

UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) INSTALL_DIR=$2; shift 2 ;;
    --bin-dir) BIN_DIR=$2; shift 2 ;;
    --no-path) NO_PATH=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[aih] 未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

LINK="$BIN_DIR/aih"
if [ "$UNINSTALL" = "1" ]; then
  if [ -L "$LINK" ]; then rm -f "$LINK"; fi
  rm -rf "$INSTALL_DIR"
  echo "[aih] 已卸载（$INSTALL_DIR）"
  exit 0
fi

if [ ! -x "$SELF_DIR/aih" ]; then
  echo "[aih] 这不是完整的安装包：找不到 $SELF_DIR/aih" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
STAGE="\${INSTALL_DIR}.new.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$SELF_DIR"/. "$STAGE"/
if [ -e "$INSTALL_DIR" ]; then
  OLD="\${INSTALL_DIR}.old.$$"
  rm -rf "$OLD"
  mv "$INSTALL_DIR" "$OLD"
  if ! mv "$STAGE" "$INSTALL_DIR"; then
    mv "$OLD" "$INSTALL_DIR"
    rm -rf "$STAGE"
    echo "[aih] 安装失败，已恢复原目录" >&2
    exit 1
  fi
  rm -rf "$OLD"
else
  mv "$STAGE" "$INSTALL_DIR"
fi

ln -sfn "$INSTALL_DIR/aih" "$LINK"
chmod +x "$INSTALL_DIR/aih" "$INSTALL_DIR/install.sh" 2>/dev/null || true

echo "[aih] 已安装 $VERSION 到 $INSTALL_DIR"
echo "[aih] 命令：$LINK"
if [ "$NO_PATH" != "1" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "[aih] 提示：把 $BIN_DIR 加入 PATH，例如："; echo "      export PATH=$BIN_DIR:\\$PATH" ;;
  esac
fi
echo "[aih] 数据目录仍是 ~/.ai_home（可用 AIH_HOME_DIR 修改）"
`;

const POWERSHELL_INSTALLER = `# AI Home 便携版 Windows 安装脚本。
param(
  [string]$Prefix = "$env:LOCALAPPDATA\\aih",
  [switch]$Uninstall,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$Version = '__AIH_VERSION__'

if ($Uninstall) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $Prefix })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  if (Test-Path -LiteralPath $Prefix) { Remove-Item -LiteralPath $Prefix -Recurse -Force }
  Write-Host "[aih] 已卸载（$Prefix）"
  exit 0
}

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $source 'aih.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "这不是完整的安装包：找不到 $launcher"
}

$stage = "$Prefix.new.$PID"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force
if (Test-Path -LiteralPath $Prefix) {
  $old = "$Prefix.old.$PID"
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
  Move-Item -LiteralPath $Prefix -Destination $old
  Move-Item -LiteralPath $stage -Destination $Prefix
  Remove-Item -LiteralPath $old -Recurse -Force
} else {
  Move-Item -LiteralPath $stage -Destination $Prefix
}

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -notcontains $Prefix) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Prefix) -join ';'), 'User')
  }
}

Write-Host "[aih] 已安装 $Version 到 $Prefix"
Write-Host "[aih] 新开一个终端后运行: aih help"
Write-Host "[aih] 数据目录仍是 %USERPROFILE%\\.ai_home（可用 AIH_HOME_DIR 修改）"
`;

function readSourceSha(repositoryRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function copyAppTree(repositoryRoot, bundleRoot) {
  for (const directory of APP_DIRECTORIES) {
    const source = path.join(repositoryRoot, directory);
    if (!fs.existsSync(source)) throw new Error(`missing required runtime directory: ${directory}`);
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
    POWERSHELL_INSTALLER.replace('__AIH_VERSION__', version),
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

function copyGoCore(repositoryRoot, bundleRoot, target) {
  const sourceDir = path.join(repositoryRoot, 'bin', 'native', targetKey(target));
  const binaryName = isWindows(target) ? 'aih-server.exe' : 'aih-server';
  const binary = path.join(sourceDir, binaryName);
  if (!fs.existsSync(binary)) return null;
  const destination = path.join(bundleRoot, 'bin', 'native', targetKey(target));
  ensureDir(destination);
  copyTree(binary, path.join(destination, binaryName), { dereference: true });
  const stamp = `${binary}.build.json`;
  if (fs.existsSync(stamp)) copyTree(stamp, path.join(destination, `${binaryName}.build.json`));
  // bin/native 里可能残留其它历史二进制（例如 aih-go），只带当前 Go Core。
  for (const name of fs.readdirSync(destination)) {
    if (name !== binaryName && name !== `${binaryName}.build.json`) removeIfExists(path.join(destination, name));
  }
  if (!isWindows(target)) fs.chmodSync(path.join(destination, binaryName), 0o755);
  return {
    binary: `bin/native/${targetKey(target)}/${binaryName}`,
    sha256: require('./fs-utils').sha256File(binary)
  };
}

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
  const goCore = options.skipGo ? null : copyGoCore(repositoryRoot, bundleRoot, target);
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
