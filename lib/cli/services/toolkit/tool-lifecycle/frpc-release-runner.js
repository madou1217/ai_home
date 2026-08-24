'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { request: undiciRequest } = require('undici');
const {
  normalizeArch,
  normalizeExternalFrpcPath,
  resolveManagedFrpcPath,
  resolvePlatform
} = require('./shared');

const RELEASE_API_URL = 'https://api.github.com/repos/fatedier/frp/releases/latest';
const CHECKSUM_ASSET_NAME = 'frp_sha256_checksums.txt';
const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : '';
}

function resolveAssetSpec(platform, arch, version) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedPlatform = resolvePlatform({ platform, processObj: { platform, arch, env: {} } });
  const normalizedArch = normalizeArch({ arch, platform: normalizedPlatform, processObj: { platform: normalizedPlatform, arch, env: {} } });
  if (!normalizedVersion || !normalizedArch || !['darwin', 'linux', 'win32'].includes(normalizedPlatform)) return null;
  const releasePlatform = normalizedPlatform === 'win32' ? 'windows' : normalizedPlatform;
  const archiveFormat = normalizedPlatform === 'win32' ? 'zip' : 'tar.gz';
  const rootName = `frp_${normalizedVersion}_${releasePlatform}_${normalizedArch}`;
  return {
    platform: normalizedPlatform,
    releasePlatform,
    arch: normalizedArch,
    version: normalizedVersion,
    archiveFormat,
    rootName,
    assetName: `${rootName}.${archiveFormat}`,
    binaryName: normalizedPlatform === 'win32' ? 'frpc.exe' : 'frpc'
  };
}

function parseChecksum(content, assetName) {
  const expectedName = String(assetName || '').trim();
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const fileName = String(match[2] || '').trim().replace(/^\.\//, '');
    if (fileName === expectedName) return match[1].toLowerCase();
  }
  return '';
}

function isOfficialReleaseAssetUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/fatedier/frp/releases/download/');
  } catch (_error) {
    return false;
  }
}

async function responseBytes(response, maxBytes) {
  if (!response || !response.body) return Buffer.alloc(0);
  if (typeof response.body.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.body.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('frpc_release_response_too_large');
    return buffer;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('frpc_release_response_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function requestBytes(url, maxBytes, options = {}) {
  const requestImpl = options.requestImpl || undiciRequest;
  const response = await requestImpl(url, {
    method: 'GET',
    headers: {
      Accept: url === RELEASE_API_URL ? 'application/vnd.github+json' : 'application/octet-stream',
      'User-Agent': 'ai-home-toolkit'
    },
    headersTimeout: 30_000,
    bodyTimeout: 180_000,
    maxRedirections: 3
  });
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(`frpc_release_http_${response && response.statusCode || 0}`);
    error.code = 'frpc_release_http_error';
    throw error;
  }
  return responseBytes(response, maxBytes);
}

function resolveReleaseAssets(release, options = {}) {
  const version = normalizeVersion(release && release.tag_name);
  const spec = resolveAssetSpec(
    options.platform || (options.processObj || process).platform,
    options.arch || (options.processObj || process).arch,
    version
  );
  if (!spec) return { ok: false, error: 'frpc_release_unsupported_target' };
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const archive = assets.find((asset) => String(asset && asset.name || '') === spec.assetName);
  const checksum = assets.find((asset) => String(asset && asset.name || '') === CHECKSUM_ASSET_NAME);
  const archiveUrl = String(archive && archive.browser_download_url || '');
  const checksumUrl = String(checksum && checksum.browser_download_url || '');
  if (!isOfficialReleaseAssetUrl(archiveUrl) || !isOfficialReleaseAssetUrl(checksumUrl)) {
    return { ok: false, error: 'frpc_release_asset_unavailable' };
  }
  return { ok: true, spec, archiveUrl, checksumUrl };
}

function extractArchiveDefault(archive, spec, options = {}) {
  const fsImpl = options.fs || fs;
  const osImpl = options.os || os;
  const spawnSync = options.spawnSync || systemSpawnSync;
  const tempRoot = fsImpl.mkdtempSync(path.join(osImpl.tmpdir(), 'aih-frpc-release-'));
  const archivePath = path.join(tempRoot, spec.assetName);
  const extractDir = path.join(tempRoot, 'extract');
  try {
    fsImpl.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(archivePath, archive, { mode: 0o600 });
    let result;
    if (spec.archiveFormat === 'tar.gz') {
      result = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
      });
    } else {
      const env = options.env || (options.processObj || process).env || {};
      const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
      const powershell = systemRoot
        ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const script = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force";
      result = spawnSync(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
        archivePath,
        extractDir
      ], {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
      });
    }
    if (!result || result.status !== 0) {
      const error = new Error(String(result && result.stderr || 'frpc_release_extract_failed').trim());
      error.code = 'frpc_release_extract_failed';
      throw error;
    }
    const binaryPath = path.join(extractDir, spec.rootName, spec.binaryName);
    const stat = fsImpl.statSync(binaryPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('frpc_release_binary_missing');
    return fsImpl.readFileSync(binaryPath);
  } finally {
    try { fsImpl.rmSync(tempRoot, { recursive: true, force: true }); } catch (_error) {}
  }
}

function publishBinary(binary, targetPath, spec, options = {}) {
  const fsImpl = options.fs || fs;
  const spawnSync = options.spawnSync || systemSpawnSync;
  const targetDir = path.dirname(targetPath);
  fsImpl.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const extension = path.extname(targetPath);
  const basename = path.basename(targetPath, extension);
  const nonce = crypto.randomBytes(6).toString('hex');
  const temporaryPath = path.join(targetDir, `.${basename}.tmp-${process.pid}-${nonce}${extension}`);
  const backupPath = path.join(targetDir, `.${basename}.backup-${process.pid}-${nonce}${extension}`);
  fsImpl.writeFileSync(temporaryPath, binary, { mode: 0o700 });
  try {
    fsImpl.chmodSync?.(temporaryPath, 0o700);
    const verified = typeof options.verifyBinary === 'function'
      ? options.verifyBinary(temporaryPath, spec)
      : Boolean(spawnSync(temporaryPath, ['--version'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true
        })?.status === 0);
    if (!verified) return { ok: false, error: 'frpc_release_binary_invalid' };

    if (spec.platform === 'win32' && fsImpl.existsSync(targetPath)) {
      fsImpl.renameSync(targetPath, backupPath);
      try {
        fsImpl.renameSync(temporaryPath, targetPath);
        fsImpl.unlinkSync(backupPath);
      } catch (error) {
        try { fsImpl.renameSync(backupPath, targetPath); } catch (_restoreError) {}
        throw error;
      }
    } else {
      fsImpl.renameSync(temporaryPath, targetPath);
    }
    fsImpl.chmodSync?.(targetPath, 0o700);
    return { ok: true };
  } finally {
    try { fsImpl.unlinkSync(temporaryPath); } catch (_error) {}
    try { fsImpl.unlinkSync(backupPath); } catch (_error) {}
  }
}

async function executeFrpcReleaseAction(action, options = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (!['install', 'update', 'uninstall'].includes(normalizedAction)) {
    return { ok: false, error: 'unsupported_managed_tool_action' };
  }
  const requestedTarget = String(options.targetPath || '').trim();
  const targetPath = normalizedAction === 'uninstall' && requestedTarget
    ? normalizeExternalFrpcPath(requestedTarget, options)
    : resolveManagedFrpcPath(options);
  if (normalizedAction === 'uninstall' && requestedTarget && !targetPath) {
    return { ok: false, error: 'frpc_uninstall_target_unsafe' };
  }
  if (!targetPath) return { ok: false, error: 'frpc_managed_target_unavailable' };
  const fsImpl = options.fs || fs;

  if (normalizedAction === 'uninstall') {
    try {
      fsImpl.unlinkSync(targetPath);
      return { ok: true, installed: false, removed: true, executablePath: targetPath };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, installed: false, removed: false, executablePath: targetPath };
      }
      return { ok: false, error: 'frpc_uninstall_failed', message: String(error && error.message || error) };
    }
  }

  try {
    const releaseBytes = await requestBytes(RELEASE_API_URL, MAX_RELEASE_BYTES, options);
    const release = JSON.parse(releaseBytes.toString('utf8'));
    const selected = resolveReleaseAssets(release, options);
    if (!selected.ok) return selected;
    const checksumBytes = await requestBytes(selected.checksumUrl, MAX_CHECKSUM_BYTES, options);
    const expectedDigest = parseChecksum(checksumBytes.toString('utf8'), selected.spec.assetName);
    if (!expectedDigest) return { ok: false, error: 'frpc_release_checksum_missing' };
    const archive = await requestBytes(selected.archiveUrl, MAX_ARCHIVE_BYTES, options);
    const actualDigest = crypto.createHash('sha256').update(archive).digest('hex');
    if (actualDigest !== expectedDigest) return { ok: false, error: 'frpc_release_digest_mismatch' };
    const binary = typeof options.extractArchive === 'function'
      ? await options.extractArchive(archive, selected.spec)
      : extractArchiveDefault(archive, selected.spec, options);
    if (!Buffer.isBuffer(binary) || binary.length === 0) {
      return { ok: false, error: 'frpc_release_binary_missing' };
    }
    const published = publishBinary(binary, targetPath, selected.spec, options);
    if (!published.ok) return published;
    return {
      ok: true,
      installed: true,
      version: selected.spec.version,
      executablePath: targetPath,
      digest: actualDigest
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.code || error && error.message || 'frpc_release_install_failed'),
      message: String(error && error.message || error || 'frpc_release_install_failed')
    };
  }
}

async function main(argv = process.argv.slice(2)) {
  const targetFlagIndex = argv.indexOf('--target');
  const result = await executeFrpcReleaseAction(argv[0], {
    confirmed: true,
    platform: process.platform,
    arch: process.arch,
    hostHomeDir: process.env.AIH_HOST_HOME || '',
    targetPath: targetFlagIndex >= 0 ? argv[targetFlagIndex + 1] || '' : '',
    env: process.env,
    processObj: process
  });
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CHECKSUM_ASSET_NAME,
  RELEASE_API_URL,
  executeFrpcReleaseAction,
  extractArchiveDefault,
  isOfficialReleaseAssetUrl,
  main,
  normalizeVersion,
  parseChecksum,
  publishBinary,
  resolveAssetSpec,
  resolveReleaseAssets,
  responseBytes
};
