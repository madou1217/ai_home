'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensurePrivateDirectory } = require('../../secure-file-io');
const {
  createCoreDiscovery,
  createCoreInstaller,
  isExecutable,
  parseVersion,
  resolveEnv,
  resolveHome,
  resolvePlatform
} = require('../core-installer');

const RELEASE_API_URL = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest';
// 规则动作（route / reject / sniff / hijack-dns）自 1.11 起提供，生成的配置依赖它。
const MIN_SUPPORTED_VERSION = '1.11.0';

function targetAssetNames(platform, arch, version) {
  const extension = platform === 'windows' ? 'zip' : 'tar.gz';
  return [`sing-box-${version}-${platform}-${arch}.${extension}`];
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isSupportedVersion(version) {
  return Boolean(version) && compareVersions(version, MIN_SUPPORTED_VERSION) >= 0;
}

// 发布包内是 sing-box-<ver>-<os>-<arch>/sing-box[.exe]；用系统 tar / unzip / PowerShell 解出单个可执行文件。
function extractSingBoxArchive(archive, tempPath, plan, options = {}) {
  const fsImpl = options.fs || fs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const archivePath = `${tempPath}.archive`;
  const extractionDir = `${tempPath}.extract`;
  const executable = plan.platform === 'windows' ? 'sing-box.exe' : 'sing-box';
  try {
    fsImpl.writeFileSync(archivePath, archive, { mode: 0o600 });
    ensurePrivateDirectory(fsImpl, extractionDir);
    let result;
    if (plan.archiveFormat === 'tar.gz') {
      result = spawnSyncImpl('tar', ['-xzf', archivePath, '-C', extractionDir], { encoding: 'utf8', windowsHide: true });
    } else if (plan.archiveFormat === 'zip') {
      result = plan.platform === 'windows'
        ? spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          archivePath, extractionDir], { encoding: 'utf8', windowsHide: true })
        : spawnSyncImpl('unzip', ['-q', archivePath, '-d', extractionDir], { encoding: 'utf8', windowsHide: true });
    } else {
      return false;
    }
    if (!result || result.status !== 0) return false;
    const found = findFile(fsImpl, extractionDir, executable, 3);
    if (!found) return false;
    fsImpl.copyFileSync(found, tempPath);
    fsImpl.chmodSync?.(tempPath, 0o700);
    return true;
  } finally {
    try { fsImpl.unlinkSync(archivePath); } catch (_error) { /* best effort */ }
    try { fsImpl.rmSync(extractionDir, { recursive: true, force: true }); } catch (_error) { /* best effort */ }
  }
}

function findFile(fsImpl, directory, name, depth) {
  let entries = [];
  try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return ''; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  if (depth <= 0) return '';
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(fsImpl, path.join(directory, entry.name), name, depth - 1);
    if (found) return found;
  }
  return '';
}

const installer = createCoreInstaller({
  coreId: 'sing-box',
  releaseApiUrl: RELEASE_API_URL,
  binaryName: 'sing-box',
  platforms: ['darwin', 'linux', 'windows'],
  arches: ['amd64', 'arm64', '386', 'armv7'],
  targetAssetNames,
  extractArchive: extractSingBoxArchive
});

const managedSingBoxRoot = installer.managedRoot;

function executableName(options) {
  return resolvePlatform(options) === 'windows' ? 'sing-box.exe' : 'sing-box';
}

function knownSingBoxCandidates(options = {}) {
  const platform = resolvePlatform(options);
  if (platform === 'windows') {
    const home = String(resolveEnv(options).USERPROFILE || os.homedir()).trim();
    return [path.join(home, 'scoop', 'apps', 'sing-box', 'current', 'sing-box.exe')];
  }
  return ['/opt/homebrew/bin/sing-box', '/usr/local/bin/sing-box', '/usr/bin/sing-box'];
}

const discovery = createCoreDiscovery({
  envVar: 'AIH_SING_BOX_BIN',
  versionArgs: ['version'],
  commandNames: ['sing-box'],
  // 受管安装与 ZCode 出口的 $AIH_HOME/bin/sing-box 共用同一份程序。
  managedCandidates: (options = {}) => [
    path.join(managedSingBoxRoot(options), 'current', executableName(options)),
    path.join(resolveHome(options), 'bin', executableName(options))
  ],
  knownCandidates: knownSingBoxCandidates
});

function discoverSingBoxCore(options = {}) {
  const found = discovery.discover(options);
  if (found.installed && !isSupportedVersion(found.version)) {
    return { ...found, reusable: false, error: 'core_version_unsupported', minVersion: MIN_SUPPORTED_VERSION };
  }
  return found;
}

/** 运行时用的程序定位（形状与 mihomo discoverMihomoBinary 一致）。 */
function discoverSingBoxBinary(options = {}) {
  const found = discoverSingBoxCore({ ...options, fs: options.fs || fs });
  if (!found.installed || found.error) return null;
  return {
    path: found.binaryPath,
    binaryName: found.binaryName,
    source: found.source,
    managed: Boolean(found.managed)
  };
}

module.exports = {
  MIN_SUPPORTED_VERSION,
  RELEASE_API_URL,
  compareVersions,
  discoverSingBoxBinary,
  discoverSingBoxCore,
  executeSingBoxInstall: installer.execute,
  extractSingBoxArchive,
  isExecutable,
  isSupportedVersion,
  managedSingBoxRoot,
  parseVersion,
  planSingBoxInstall: installer.plan,
  removeManagedSingBox: installer.remove,
  targetAssetNames
};
