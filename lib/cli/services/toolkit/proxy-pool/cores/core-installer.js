'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { request } = require('undici');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../secure-file-io');

/**
 * 代理内核程序的共用安装流水线（模板方法）：
 *   发布元数据 → 按平台/架构选官方资产（带 sha256 digest）→ 绑定 planId → 下载 → 校验 digest
 *   → 由内核提供的解压策略取出可执行文件 → 发布到 <AIH_HOME>/tools/<coreId>/{<version>,current}。
 * 各内核只提供：发布 API、资产命名、可执行文件名、解压方式。
 */
const OFFICIAL_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);

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

function officialDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !OFFICIAL_DOWNLOAD_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch (_error) {
    return null;
  }
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

// GitHub 发布下载会 302 到 objects/release-assets 域名；逐跳跟随，且每一跳都必须是官方下载域名。
async function downloadOfficial(url, requestImpl, maxRedirects = 5) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await requestImpl(current, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'ai-home-toolkit' },
      headersTimeout: 30000,
      bodyTimeout: 120000
    });
    const location = response?.headers?.location;
    if (!response || response.statusCode < 300 || response.statusCode >= 400 || !location) return response;
    try { await response.body?.dump?.(); } catch (_error) { /* drain best effort */ }
    const next = officialDownloadUrl(new URL(String(location), current).toString());
    if (!next) {
      const error = new Error('redirect to a non-official download host');
      error.code = 'core_download_redirect_untrusted';
      throw error;
    }
    current = next;
  }
  const error = new Error('too many redirects');
  error.code = 'core_download_redirect_loop';
  throw error;
}

function archiveFormatOf(assetName) {
  if (assetName.endsWith('.zip')) return 'zip';
  if (assetName.endsWith('.tar.gz') || assetName.endsWith('.tgz')) return 'tar.gz';
  return 'gz';
}

/**
 * @param {Object} spec
 * @param {string} spec.coreId 受管目录名（tools/<coreId>）
 * @param {string} spec.releaseApiUrl GitHub releases/latest API
 * @param {string} spec.binaryName 可执行文件名（不含 .exe）
 * @param {(platform, arch, version) => string[]} spec.targetAssetNames 候选资产名（按优先级）
 * @param {string[]} spec.platforms / spec.arches 支持的平台与架构
 * @param {(archive, tempPath, plan, options) => Promise<boolean>|boolean} spec.extractArchive 解压策略
 */
function createCoreInstaller(spec) {
  const managedRoot = (options = {}) => path.join(resolveHome(options), 'tools', spec.coreId);
  const executableName = (platform) => (platform === 'windows' ? `${spec.binaryName}.exe` : spec.binaryName);

  function selectReleaseAsset(metadata, platform, arch) {
    const version = String(metadata?.tag_name || '').replace(/^v/, '');
    if (!version || metadata?.draft || metadata?.prerelease) return null;
    const assets = Array.isArray(metadata.assets) ? metadata.assets : [];
    const names = spec.targetAssetNames(platform, arch, version);
    const asset = names.map((name) => assets.find((candidate) => candidate.name === name)).find(Boolean);
    if (!asset) return null;
    const downloadUrl = officialDownloadUrl(asset.browser_download_url);
    // 没有官方 sha256 digest 的资产一律不装：宁可拒绝也不安装未校验的程序。
    const digest = validateDigest(String(asset.digest || '').replace(/^sha256:/i, ''));
    if (!downloadUrl || !digest) return null;
    return {
      version,
      assetName: asset.name,
      downloadUrl,
      digest,
      size: Number(asset.size || 0),
      archiveFormat: archiveFormatOf(asset.name)
    };
  }

  async function plan(input = {}, options = {}) {
    const platform = resolvePlatform({ ...options, platform: input.platform || resolvePlatform(options) });
    const arch = resolveArch({ ...options, arch: input.arch || resolveArch(options) });
    if (!spec.platforms.includes(platform)) return { ok: false, error: 'unsupported_core_platform' };
    if (!spec.arches.includes(arch)) return { ok: false, error: 'unsupported_core_architecture' };
    const requestImpl = options.requestImpl || request;
    let response;
    try {
      response = await requestImpl(spec.releaseApiUrl, {
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
    const targetDir = path.join(managedRoot({ ...options, aiHomeDir }), selected.version);
    const targetPath = path.join(targetDir, executableName(platform));
    return {
      ok: true,
      plan: {
        ...selected,
        coreId: spec.coreId,
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
    const root = path.resolve(managedRoot({ aiHomeDir }));
    const target = path.resolve(targetPath);
    return target === root || target.startsWith(`${root}${path.sep}`);
  }

  async function execute(installPlan = {}, options = {}) {
    const aiHomeDir = resolveHome(options);
    if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
    if (!installPlan.official || !installPlan.managed || !installPlan.version || !validateDigest(installPlan.digest)
      || installPlan.planId !== createInstallPlanId(installPlan.version, installPlan.digest, aiHomeDir)
      || !isSafeManagedTarget(installPlan.targetPath, aiHomeDir)
      || !officialDownloadUrl(installPlan.downloadUrl)) {
      return { ok: false, error: 'install_plan_invalid' };
    }
    let response;
    try {
      response = await downloadOfficial(installPlan.downloadUrl, options.requestImpl || request);
    } catch (error) {
      return { ok: false, error: error.code || 'core_download_failed', message: error.message };
    }
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      return { ok: false, error: 'core_download_http_error', statusCode: response?.statusCode || null };
    }
    const archive = await responseBytes(response);
    const actualDigest = crypto.createHash('sha256').update(archive).digest('hex');
    if (actualDigest !== String(installPlan.digest).toLowerCase()) return { ok: false, error: 'core_download_digest_mismatch' };

    const fsImpl = options.fs || fs;
    ensurePrivateDirectory(fsImpl, installPlan.targetDir);
    const tempPath = `${installPlan.targetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      const extract = typeof options.extractArchive === 'function' ? options.extractArchive : spec.extractArchive;
      const extracted = await extract(archive, tempPath, installPlan, { ...options, fs: fsImpl });
      if (extracted === false) return { ok: false, error: 'core_archive_format_unsupported' };
      if (typeof options.verifyBinary === 'function') {
        if (!options.verifyBinary(tempPath, installPlan)) return { ok: false, error: 'core_binary_invalid' };
      } else if (!isExecutable(tempPath, { fs: fsImpl })) {
        if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, 0o700);
        if (!isExecutable(tempPath, { fs: fsImpl })) return { ok: false, error: 'core_binary_invalid' };
      }
      if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, 0o700);
      fsImpl.renameSync(tempPath, installPlan.targetPath);
      const currentDir = path.join(managedRoot({ aiHomeDir }), 'current');
      ensurePrivateDirectory(fsImpl, currentDir);
      const currentPath = path.join(currentDir, path.basename(installPlan.targetPath));
      const currentTemp = `${currentPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fsImpl.copyFileSync(installPlan.targetPath, currentTemp);
        fsImpl.chmodSync?.(currentTemp, 0o700);
        fsImpl.renameSync(currentTemp, currentPath);
        atomicWritePrivateFile(fsImpl, path, path.join(managedRoot({ aiHomeDir }), 'current.json'), JSON.stringify({
          version: installPlan.version,
          digest: installPlan.digest,
          assetName: installPlan.assetName,
          updatedAt: Date.now()
        }));
      } finally {
        try { fsImpl.unlinkSync(currentTemp); } catch (_error) {}
      }
      return { ok: true, managed: true, version: installPlan.version, digest: installPlan.digest, binaryPath: currentPath };
    } catch (error) {
      try { fsImpl.unlinkSync(tempPath); } catch (_cleanupError) {}
      return { ok: false, error: 'core_install_publish_failed', message: error.message };
    }
  }

  function remove(options = {}) {
    if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
    const root = managedRoot(options);
    const fsImpl = options.fs || fs;
    try {
      fsImpl.rmSync(root, { recursive: true, force: false });
      return { ok: true, removed: true, managed: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, removed: false, managed: true };
      return { ok: false, error: 'core_uninstall_failed', message: error.message };
    }
  }

  return { managedRoot, plan, execute, remove, selectReleaseAsset };
}

/**
 * 通用的已安装程序探测：按「环境变量 → 受管目录 → PATH → 已知安装位置」顺序，
 * 用 versionArgs 实际运行一次确认可用并读取版本。
 */
function createCoreDiscovery(spec) {
  function probeCandidate(candidate, source, managed, options = {}) {
    if (!isExecutable(candidate, options)) return null;
    const spawnSyncImpl = options.spawnSync || spawnSync;
    let result;
    try {
      result = spawnSyncImpl(candidate, spec.versionArgs, {
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

  function pathCandidates(options = {}) {
    const env = resolveEnv(options);
    const platform = resolvePlatform(options);
    const pathEntries = String(env.PATH || '').split(platform === 'windows' ? ';' : ':').filter(Boolean);
    const suffixes = platform === 'windows' ? ['.exe', ''] : [''];
    return pathEntries.flatMap((entry) => spec.commandNames.flatMap((name) => (
      suffixes.map((suffix) => path.join(entry, `${name}${suffix}`))
    )));
  }

  function discover(options = {}) {
    const fsImpl = options.fs || fs;
    const env = resolveEnv(options);
    const explicit = String(env[spec.envVar] || '').trim();
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
    const managedCandidates = spec.managedCandidates(options);
    for (const candidate of [...new Set(managedCandidates)]) {
      const found = probeCandidate(candidate, 'managed', true, options);
      if (found) return found;
    }
    for (const candidate of [...new Set(pathCandidates(options))]) {
      const found = probeCandidate(candidate, 'path', false, options);
      if (found) return found;
    }
    const known = spec.knownCandidates(options);
    for (const candidate of [...new Set(known)]) {
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
        ...known
      ])].filter((candidate) => {
        try { return fsImpl.existsSync(candidate); } catch (_error) { return false; }
      }).length
    };
  }

  return { discover, probeCandidate, pathCandidates };
}

module.exports = {
  OFFICIAL_DOWNLOAD_HOSTS,
  downloadOfficial,
  createCoreDiscovery,
  createCoreInstaller,
  createInstallPlanId,
  isExecutable,
  officialDownloadUrl,
  parseVersion,
  resolveArch,
  resolveEnv,
  resolveHome,
  resolvePlatform,
  validateDigest
};
