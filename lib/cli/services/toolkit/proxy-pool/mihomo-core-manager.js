'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { request } = require('undici');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('./secure-file-io');

const RELEASE_API_URL = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const OFFICIAL_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const DEFAULT_PORT_MIN = 10800;
const DEFAULT_PORT_MAX = 10832;

function resolvePlatform(options = {}) {
  const value = String(options.platform || options.processObj?.platform || process.platform).trim().toLowerCase();
  return value === 'win32' ? 'windows' : value;
}

function resolveArch(options = {}) {
  const value = String(options.arch || options.processObj?.arch || process.arch).trim().toLowerCase();
  if (['x64', 'amd64'].includes(value)) return 'amd64';
  if (['arm64', 'aarch64'].includes(value)) return 'arm64';
  if (['arm', 'armv7l', 'armv7'].includes(value)) return 'armv7';
  if (['ia32', 'x86', '386'].includes(value)) return '386';
  return value;
}

function resolveEnv(options = {}) {
  return options.env || options.processObj?.env || process.env || {};
}

function resolveHome(options = {}) {
  const env = resolveEnv(options);
  return String(options.aiHomeDir || env.AIH_HOME || env.AI_HOME || path.join(os.homedir(), '.ai_home')).trim();
}

function managedMihomoRoot(options = {}) {
  return path.join(resolveHome(options), 'tools', 'mihomo');
}

function parseVersion(value) {
  const match = String(value || '').match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3})(?=$|[^0-9])/i);
  return match ? match[1] : '';
}

function isExecutable(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  if (!filePath) return false;
  try {
    if (!fsImpl.statSync(filePath).isFile()) return false;
    fsImpl.accessSync?.(filePath, fsImpl.constants?.X_OK || fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

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

function pathCandidates(options = {}) {
  const env = resolveEnv(options);
  const platform = resolvePlatform(options);
  const pathEntries = String(env.PATH || '').split(platform === 'windows' ? ';' : ':').filter(Boolean);
  const suffixes = platform === 'windows' ? ['.exe', ''] : [''];
  return pathEntries.flatMap((entry) => ['mihomo', 'clash-meta'].flatMap((name) => (
    suffixes.map((suffix) => path.join(entry, `${name}${suffix}`))
  )));
}

function probeCandidate(candidate, source, managed, options = {}) {
  if (!isExecutable(candidate, options)) return null;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  let result;
  try {
    result = spawnSyncImpl(candidate, ['-v'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      env: resolveEnv(options)
    });
  } catch (_error) {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const version = parseVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  return {
    installed: true,
    source,
    managed,
    reusable: true,
    binaryName: path.basename(candidate),
    version: version || null,
    binaryPath: candidate
  };
}

function discoverMihomoCore(options = {}) {
  const fsImpl = options.fs || fs;
  const env = resolveEnv(options);
  const explicit = String(env.AIH_MIHOMO_BIN || '').trim();
  if (explicit) {
    const found = probeCandidate(explicit, 'env', false, options);
    if (found) return found;
    return {
      installed: false,
      source: 'env',
      managed: false,
      reusable: false,
      binaryName: path.basename(explicit),
      version: null,
      binaryPath: '',
      error: 'configured_binary_unavailable'
    };
  }

  const managedCandidates = [
    path.join(managedMihomoRoot(options), 'current', resolvePlatform(options) === 'windows' ? 'mihomo.exe' : 'mihomo'),
    path.join(managedMihomoRoot(options), 'current', 'mihomo')
  ];
  for (const candidate of [...new Set(managedCandidates)]) {
    const found = probeCandidate(candidate, 'managed', true, options);
    if (found) return found;
  }

  for (const candidate of [...new Set(pathCandidates(options))]) {
    const found = probeCandidate(candidate, 'path', false, options);
    if (found) return found;
  }
  for (const candidate of [...new Set(knownMihomoCandidates(options))]) {
    const found = probeCandidate(candidate, 'known-app', false, options);
    if (found) return found;
  }

  return {
    installed: false,
    source: null,
    managed: false,
    reusable: false,
    binaryName: null,
    version: null,
    binaryPath: '',
    candidatesChecked: [...new Set([
      ...managedCandidates,
      ...pathCandidates(options),
      ...knownMihomoCandidates(options)
    ])].filter((candidate) => {
      try { return fsImpl.existsSync(candidate); } catch (_error) { return false; }
    }).length
  };
}

function defaultPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('node:net').createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(available));
    };
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => finish(true));
  });
}

async function chooseLoopbackPort(preferredPort = DEFAULT_PORT_MIN, options = {}) {
  const preferred = Number(preferredPort);
  const minPort = Number(options.minPort || DEFAULT_PORT_MIN);
  const maxPort = Number(options.maxPort || DEFAULT_PORT_MAX);
  const isPortAvailable = options.isPortAvailable || defaultPortAvailable;
  const reservedPorts = new Set((options.reservedPorts || []).map(Number));
  const candidates = [];
  if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535) candidates.push(preferred);
  for (let port = minPort; port <= maxPort; port += 1) {
    if (!candidates.includes(port)) candidates.push(port);
  }
  for (const port of candidates) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      return {
        ok: true,
        port,
        requestedPort: preferred,
        reused: port === preferred,
        reason: port === preferred ? 'preferred_port_available' : 'preferred_port_in_use'
      };
    }
  }
  return {
    ok: false,
    error: 'no_available_loopback_port',
    requestedPort: preferred,
    range: { min: minPort, max: maxPort }
  };
}

function officialDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !OFFICIAL_DOWNLOAD_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch (_error) {
    return null;
  }
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

function createInstallPlanId(version, digest, aiHomeDir) {
  return crypto.createHash('sha256')
    .update(`${version}\0${digest}\0${aiHomeDir}`, 'utf8')
    .digest('hex');
}

function validateDigest(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
}

async function responseText(response) {
  if (response?.body?.text) return response.body.text();
  return String(response?.body || '');
}

async function responseBytes(response) {
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (response?.body?.arrayBuffer) return Buffer.from(await response.body.arrayBuffer());
  if (response?.body?.text) return Buffer.from(await response.body.text());
  return Buffer.from(response?.body || '');
}

function selectReleaseAsset(metadata, platform, arch) {
  const version = String(metadata?.tag_name || '').replace(/^v/, '');
  if (!version || metadata?.draft || metadata?.prerelease) return null;
  const assets = Array.isArray(metadata.assets) ? metadata.assets : [];
  const names = targetAssetNames(platform, arch, version);
  const asset = names.map((name) => assets.find((candidate) => candidate.name === name)).find(Boolean);
  if (!asset) return null;
  const downloadUrl = officialDownloadUrl(asset.browser_download_url);
  const digest = validateDigest(String(asset.digest || '').replace(/^sha256:/i, ''));
  if (!downloadUrl || !digest) return null;
  return {
    version,
    assetName: asset.name,
    downloadUrl,
    digest,
    size: Number(asset.size || 0),
    archiveFormat: asset.name.endsWith('.zip') ? 'zip' : 'gz'
  };
}

async function planMihomoInstall(input = {}, options = {}) {
  const platform = resolvePlatform({ ...options, platform: input.platform || resolvePlatform(options) });
  const arch = resolveArch({ ...options, arch: input.arch || resolveArch(options) });
  if (!['darwin', 'linux', 'windows', 'freebsd'].includes(platform)) {
    return { ok: false, error: 'unsupported_core_platform' };
  }
  if (!['amd64', 'arm64', 'armv7', '386'].includes(arch)) {
    return { ok: false, error: 'unsupported_core_architecture' };
  }
  const requestImpl = options.requestImpl || request;
  let response;
  try {
    response = await requestImpl(RELEASE_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-home-toolkit' },
      headersTimeout: 10000,
      bodyTimeout: 10000
    });
  } catch (error) {
    return { ok: false, error: 'core_release_fetch_failed', message: error.message };
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    return { ok: false, error: 'core_release_http_error', statusCode: response?.statusCode || null };
  }
  let metadata;
  try { metadata = JSON.parse(await responseText(response)); } catch (_error) {
    return { ok: false, error: 'core_release_metadata_invalid' };
  }
  const selected = selectReleaseAsset(metadata, platform, arch);
  if (!selected) return { ok: false, error: 'core_release_asset_unavailable' };
  const aiHomeDir = resolveHome(options);
  const targetDir = path.join(managedMihomoRoot({ ...options, aiHomeDir }), selected.version);
  const targetPath = path.join(targetDir, platform === 'windows' ? 'mihomo.exe' : 'mihomo');
  return {
    ok: true,
    plan: {
      ...selected,
      platform,
      arch,
      official: true,
      managed: true,
      targetDir,
      targetPath,
      aiHomeDir,
      planId: createInstallPlanId(selected.version, selected.digest, aiHomeDir)
    }
  };
}

function isSafeManagedTarget(targetPath, aiHomeDir) {
  const root = path.resolve(managedMihomoRoot({ aiHomeDir }));
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function executeMihomoInstall(plan = {}, options = {}) {
  const aiHomeDir = resolveHome(options);
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (!plan.official || !plan.managed || !plan.version || !validateDigest(plan.digest)
    || plan.planId !== createInstallPlanId(plan.version, plan.digest, aiHomeDir)
    || !isSafeManagedTarget(plan.targetPath, aiHomeDir)
    || !officialDownloadUrl(plan.downloadUrl)) {
    return { ok: false, error: 'install_plan_invalid' };
  }
  const requestImpl = options.requestImpl || request;
  let response;
  try {
    response = await requestImpl(plan.downloadUrl, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'ai-home-toolkit' },
      headersTimeout: 30000,
      bodyTimeout: 120000
    });
  } catch (error) {
    return { ok: false, error: 'core_download_failed', message: error.message };
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    return { ok: false, error: 'core_download_http_error', statusCode: response?.statusCode || null };
  }
  const archive = await responseBytes(response);
  const actualDigest = crypto.createHash('sha256').update(archive).digest('hex');
  if (actualDigest !== String(plan.digest).toLowerCase()) return { ok: false, error: 'core_download_digest_mismatch' };

  const fsImpl = options.fs || fs;
  ensurePrivateDirectory(fsImpl, plan.targetDir);
  const tempPath = `${plan.targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    if (typeof options.extractArchive === 'function') {
      await options.extractArchive(archive, tempPath, plan);
    } else if (plan.archiveFormat === 'gz') {
      fsImpl.writeFileSync(tempPath, zlib.gunzipSync(archive), { mode: 0o700 });
    } else if (plan.archiveFormat === 'zip') {
      const extracted = await extractZipArchive(archive, tempPath, plan, { ...options, fs: fsImpl });
      if (!extracted) return { ok: false, error: 'core_archive_format_unsupported' };
    } else {
      return { ok: false, error: 'core_archive_format_unsupported' };
    }
    if (typeof options.verifyBinary === 'function') {
      if (!options.verifyBinary(tempPath, plan)) return { ok: false, error: 'core_binary_invalid' };
    } else if (!isExecutable(tempPath, { fs: fsImpl })) {
      if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, 0o700);
      if (!isExecutable(tempPath, { fs: fsImpl })) return { ok: false, error: 'core_binary_invalid' };
    }
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, 0o700);
    fsImpl.renameSync(tempPath, plan.targetPath);
    const currentDir = path.join(managedMihomoRoot({ aiHomeDir }), 'current');
    ensurePrivateDirectory(fsImpl, currentDir);
    const currentPath = path.join(currentDir, path.basename(plan.targetPath));
    const currentTemp = `${currentPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.copyFileSync(plan.targetPath, currentTemp);
      fsImpl.chmodSync?.(currentTemp, 0o700);
      fsImpl.renameSync(currentTemp, currentPath);
      atomicWritePrivateFile(fsImpl, path, path.join(managedMihomoRoot({ aiHomeDir }), 'current.json'), JSON.stringify({
        version: plan.version,
        digest: plan.digest,
        assetName: plan.assetName,
        updatedAt: Date.now()
      }));
    } finally {
      try { fsImpl.unlinkSync(currentTemp); } catch (_error) {}
    }
    return { ok: true, managed: true, version: plan.version, digest: plan.digest, binaryPath: currentPath };
  } catch (error) {
    try { fsImpl.unlinkSync(tempPath); } catch (_cleanupError) {}
    return { ok: false, error: 'core_install_publish_failed', message: error.message };
  }
}

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

function removeManagedMihomo(options = {}) {
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  const root = managedMihomoRoot(options);
  const fsImpl = options.fs || fs;
  try {
    fsImpl.rmSync(root, { recursive: true, force: false });
    return { ok: true, removed: true, managed: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, removed: false, managed: true };
    return { ok: false, error: 'core_uninstall_failed', message: error.message };
  }
}

module.exports = {
  DEFAULT_PORT_MAX,
  DEFAULT_PORT_MIN,
  RELEASE_API_URL,
  chooseLoopbackPort,
  createInstallPlanId,
  discoverMihomoCore,
  executeMihomoInstall,
  knownMihomoCandidates,
  managedMihomoRoot,
  parseVersion,
  planMihomoInstall,
  removeManagedMihomo,
  targetAssetNames
};
