'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { ensurePrivateDirectory } = require('../../secure-file-io');
const {
  createCoreDiscovery,
  createCoreInstaller,
  createInstallPlanId,
  isExecutable,
  parseVersion,
  resolveEnv,
  resolvePlatform
} = require('../core-installer');

const RELEASE_API_URL = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const { DEFAULT_PORT_MAX, DEFAULT_PORT_MIN, chooseLoopbackPort } = require('../loopback-port');

function knownMihomoCandidates(options = {}) {
  const platform = resolvePlatform(options);
  const home = String(options.hostHomeDir || resolveEnv(options).HOME || resolveEnv(options).USERPROFILE || os.homedir()).trim();
  if (platform === 'darwin') {
    return [
      '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo',
      '/Applications/Clash Verge Rev.app/Contents/MacOS/verge-mihomo',
      path.join(home, 'Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'),
      path.join(home, 'Applications/Clash Verge Rev.app/Contents/MacOS/verge-mihomo')
    ];
  }
  if (platform === 'windows') {
    const localAppData = resolveEnv(options).LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(localAppData, 'Clash Verge Rev', 'verge-mihomo.exe'),
      path.join(localAppData, 'Clash Verge', 'verge-mihomo.exe')
    ];
  }
  return ['/usr/bin/mihomo', '/usr/local/bin/mihomo', '/usr/bin/clash-meta', '/usr/local/bin/clash-meta'];
}

function targetAssetNames(platform, arch, version) {
  const prefix = `mihomo-${platform}-`;
  const suffix = `-v${version}`;
  if (platform === 'darwin' && arch === 'amd64') return [
    `${prefix}amd64-compatible${suffix}.gz`,
    `${prefix}amd64${suffix}.gz`
  ];
  if (platform === 'linux' && arch === 'amd64') return [
    `${prefix}amd64-compatible${suffix}.gz`,
    `${prefix}amd64${suffix}.gz`
  ];
  const extension = platform === 'windows' ? '.zip' : '.gz';
  return [`${prefix}${arch}${suffix}${extension}`];
}

// mihomo 发布包：.gz 为单文件，Windows 为 zip。
async function extractZipArchive(archive, targetPath, plan, options = {}) {
  const fsImpl = options.fs || fs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const archivePath = `${targetPath}.archive`;
  const extractionDir = `${targetPath}.extract`;
  try {
    fsImpl.writeFileSync(archivePath, archive, { mode: 0o600 });
    ensurePrivateDirectory(fsImpl, extractionDir);
    const list = spawnSyncImpl('unzip', ['-Z1', archivePath], { encoding: 'utf8', windowsHide: true });
    if (list?.status === 0) {
      const entry = String(list.stdout || '')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => /(?:^|\/)(?:mihomo|clash-meta)(?:\.exe)?$/i.test(value));
      if (entry) {
        const extracted = spawnSyncImpl('unzip', ['-p', archivePath, entry], { encoding: null, windowsHide: true });
        if (extracted?.status === 0 && extracted.stdout) {
          fsImpl.writeFileSync(targetPath, Buffer.isBuffer(extracted.stdout) ? extracted.stdout : Buffer.from(extracted.stdout), { mode: 0o700 });
          return true;
        }
      }
    }
    if (resolvePlatform(plan) === 'windows') {
      const script = [
        "$ErrorActionPreference='Stop'",
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        "$file = Get-ChildItem -LiteralPath $args[1] -Recurse -File | Where-Object { $_.Name -match '^(mihomo|clash-meta)(\\.exe)?$' } | Select-Object -First 1",
        'if (-not $file) { exit 2 }',
        'Copy-Item -LiteralPath $file.FullName -Destination $args[2] -Force'
      ].join('; ');
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, archivePath, extractionDir, targetPath], {
        encoding: 'utf8',
        windowsHide: true
      });
      if (result?.status === 0 && isExecutable(targetPath, { fs: fsImpl })) return true;
    }
    return false;
  } finally {
    try { fsImpl.unlinkSync(archivePath); } catch (_error) { /* best effort */ }
    try { fsImpl.rmSync(extractionDir, { recursive: true, force: true }); } catch (_error) { /* best effort */ }
  }
}

async function extractMihomoArchive(archive, tempPath, plan, options = {}) {
  const fsImpl = options.fs || fs;
  if (plan.archiveFormat === 'gz') {
    fsImpl.writeFileSync(tempPath, zlib.gunzipSync(archive), { mode: 0o700 });
    return true;
  }
  if (plan.archiveFormat === 'zip') return extractZipArchive(archive, tempPath, plan, options);
  return false;
}

const installer = createCoreInstaller({
  coreId: 'mihomo',
  releaseApiUrl: RELEASE_API_URL,
  binaryName: 'mihomo',
  platforms: ['darwin', 'linux', 'windows', 'freebsd'],
  arches: ['amd64', 'arm64', 'armv7', '386'],
  targetAssetNames,
  extractArchive: extractMihomoArchive
});

const managedMihomoRoot = installer.managedRoot;

const discovery = createCoreDiscovery({
  envVar: 'AIH_MIHOMO_BIN',
  versionArgs: ['-v'],
  commandNames: ['mihomo', 'clash-meta'],
  managedCandidates: (options = {}) => [
    path.join(managedMihomoRoot(options), 'current', resolvePlatform(options) === 'windows' ? 'mihomo.exe' : 'mihomo'),
    path.join(managedMihomoRoot(options), 'current', 'mihomo')
  ],
  knownCandidates: knownMihomoCandidates
});

module.exports = {
  DEFAULT_PORT_MAX,
  DEFAULT_PORT_MIN,
  RELEASE_API_URL,
  chooseLoopbackPort,
  createInstallPlanId,
  discoverMihomoCore: discovery.discover,
  executeMihomoInstall: installer.execute,
  knownMihomoCandidates,
  managedMihomoRoot,
  parseVersion,
  planMihomoInstall: installer.plan,
  removeManagedMihomo: installer.remove,
  targetAssetNames
};
