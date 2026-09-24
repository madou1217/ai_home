#!/usr/bin/env node
'use strict';

// postinstall 的 Go Core 构件准备（Go Core 为显式 opt-in，任何失败都只提示、不让 npm install 失败）：
//   1. 现有构件的 build stamp 与当前版本/manifest 一致 → 跳过；
//   2. 本机有 Go 工具链 → 本地构建（scripts/build-go-server.js，同时写 stamp）；
//   3. 否则下载与 npm 版本匹配的预编译构件，按发布的 sha256 校验通过后才落盘并写 stamp。
// 下载源默认 GitHub Release（v<version>），可用 AIH_GO_CORE_DOWNLOAD_BASE 覆盖；
// AIH_SKIP_GO_CORE_INSTALL=1 完全跳过。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveGoServerBinary } = require('../lib/cli/services/server/go-core-supervisor');
const {
  computeRouteManifestHash,
  readPackageVersion,
  sha256Hex,
  verifyBuildStamp,
  writeBuildStamp
} = require('../lib/cli/services/server/go-core-build-stamp');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOWNLOAD_BASE = 'https://github.com/madou1217/ai_home/releases/download';

function releaseAssetName(platform, arch) {
  return `aih-server-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

function resolveDownloadUrls(options) {
  const base = String(options.downloadBase || DEFAULT_DOWNLOAD_BASE).replace(/\/+$/, '');
  const asset = releaseAssetName(options.platform, options.arch);
  const root = `${base}/v${options.version}`;
  return { binary: `${root}/${asset}`, checksum: `${root}/${asset}.sha256` };
}

function parseChecksum(text) {
  const match = String(text || '').trim().match(/^([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : '';
}

async function downloadVerified(options) {
  const fetchImpl = options.fetchImpl || fetch;
  const urls = resolveDownloadUrls(options);
  const checksumResponse = await fetchImpl(urls.checksum);
  if (!checksumResponse.ok) return { ok: false, reason: `checksum http_${checksumResponse.status}` };
  const expected = parseChecksum(await checksumResponse.text());
  if (!expected) return { ok: false, reason: 'checksum file malformed' };
  const binaryResponse = await fetchImpl(urls.binary);
  if (!binaryResponse.ok) return { ok: false, reason: `binary http_${binaryResponse.status}` };
  const bytes = Buffer.from(await binaryResponse.arrayBuffer());
  if (sha256Hex(bytes) !== expected) return { ok: false, reason: 'sha256 mismatch' };
  return { ok: true, bytes };
}

function hasGoToolchain(spawnSyncImpl) {
  const probe = spawnSyncImpl('go', ['version'], { encoding: 'utf8' });
  return probe.status === 0;
}

async function prepareGoCore(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const log = options.log || console;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (/^(1|true|yes)$/i.test(String(env.AIH_SKIP_GO_CORE_INSTALL || ''))) return { action: 'skipped' };

  const binaryPath = resolveGoServerBinary({ repositoryRoot, platform, arch });
  const version = readPackageVersion(fsImpl, repositoryRoot);
  const routeManifestHash = computeRouteManifestHash(fsImpl, repositoryRoot);
  const current = fsImpl.existsSync(binaryPath)
    ? verifyBuildStamp(fsImpl, { binaryPath, expectedVersion: version, expectedRouteManifestHash: routeManifestHash })
    : { ok: false };
  if (current.ok) return { action: 'up_to_date', binaryPath };

  if (hasGoToolchain(spawnSyncImpl)) {
    const build = spawnSyncImpl(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-go-server.js')], {
      cwd: repositoryRoot,
      stdio: 'inherit'
    });
    if (build.status === 0) return { action: 'built', binaryPath };
    log.log('ℹ️  Go Core local build failed; trying the prebuilt release binary');
  }

  try {
    const downloaded = await downloadVerified({
      fetchImpl: options.fetchImpl,
      downloadBase: env.AIH_GO_CORE_DOWNLOAD_BASE,
      platform,
      arch,
      version
    });
    if (!downloaded.ok) {
      log.log(`ℹ️  Go Core prebuilt binary unavailable (${downloaded.reason}); Go Core stays disabled until \`npm run go:build\``);
      return { action: 'unavailable', reason: downloaded.reason };
    }
    fsImpl.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const temporary = `${binaryPath}.download`;
    fsImpl.writeFileSync(temporary, downloaded.bytes, { mode: 0o755 });
    fsImpl.renameSync(temporary, binaryPath);
    writeBuildStamp(fsImpl, { binaryPath, version, routeManifestHash, target: `${platform}-${arch}`, sourceSha: `release:v${version}` });
    return { action: 'downloaded', binaryPath };
  } catch (error) {
    log.log(`ℹ️  Go Core download failed (${error.code || error.message}); Go Core stays disabled until \`npm run go:build\``);
    return { action: 'unavailable', reason: error.code || error.message };
  }
}

if (require.main === module) {
  prepareGoCore().then(
    (result) => { if (result.action !== 'up_to_date' && result.action !== 'skipped') console.log(`[aih] Go Core: ${result.action}`); },
    (error) => { console.log(`ℹ️  Go Core preparation skipped: ${error.message}`); }
  );
}

module.exports = {
  parseChecksum,
  prepareGoCore,
  releaseAssetName,
  resolveDownloadUrls
};
