'use strict';

// Go Core 构件的来源凭证（build stamp）：与二进制同目录的 <binary>.build.json。
// 构建时写入，监督器拉起前校验——版本、路由契约与二进制摘要任一不符都失败关闭，
// 避免 Node 升级后继续拉起旧 Go、或拉起被替换的二进制。

const crypto = require('node:crypto');
const nodePath = require('node:path');

const BUILD_STAMP_SCHEMA_VERSION = 1;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildStampPath(binaryPath) {
  return `${binaryPath}.build.json`;
}

function routeManifestPath(repositoryRoot, pathImpl = nodePath) {
  return pathImpl.join(repositoryRoot, 'contracts', 'route-ownership', 'manifest.json');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// 只对 Node 与 Go 之间的路由契约取摘要：每个条目的 id、Node 侧路由和 Go 侧路由。
// Go 二进制本身不读这个 manifest；它的路由统计、迁移状态、说明与证据字段变化
// 不改变哪些请求会转给 Go，不能因此判定构件过期。
function computeRouteManifestHash(fs, repositoryRoot, pathImpl = nodePath) {
  const manifest = JSON.parse(fs.readFileSync(routeManifestPath(repositoryRoot, pathImpl), 'utf8'));
  const contract = (Array.isArray(manifest && manifest.entries) ? manifest.entries : [])
    .map((entry) => ({
      id: String(entry && entry.id || ''),
      node_routes: (entry && entry.node_routes) || [],
      go_routes: (entry && entry.go_routes) || []
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sha256Hex(canonicalJson(contract));
}

function readPackageVersion(fs, repositoryRoot, pathImpl = nodePath) {
  const parsed = JSON.parse(fs.readFileSync(pathImpl.join(repositoryRoot, 'package.json'), 'utf8'));
  return String(parsed.version || '').trim();
}

/** 构建完成后写入凭证；binary_sha256 取自刚产出的二进制本身。 */
function writeBuildStamp(fs, options = {}) {
  const binaryPath = options.binaryPath;
  const stamp = {
    schema_version: BUILD_STAMP_SCHEMA_VERSION,
    version: String(options.version || '').trim(),
    route_manifest_sha256: String(options.routeManifestHash || '').trim(),
    binary_sha256: sha256Hex(fs.readFileSync(binaryPath)),
    source_sha: String(options.sourceSha || '').trim(),
    target: String(options.target || '').trim(),
    built_at: options.builtAt || new Date().toISOString()
  };
  fs.writeFileSync(buildStampPath(binaryPath), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

function stampError(code, detail) {
  return { ok: false, code, detail };
}

/**
 * 校验二进制与凭证、以及凭证与当前 Node 宿主是否一致。
 * 返回 { ok, code, stamp }，code 取值：go_core_build_unverified / go_core_build_mismatch。
 */
function verifyBuildStamp(fs, options = {}) {
  const binaryPath = options.binaryPath;
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(buildStampPath(binaryPath), 'utf8'));
  } catch (_error) {
    return stampError('go_core_build_unverified', 'build stamp missing or unreadable; run npm run go:build');
  }
  if (!stamp || stamp.schema_version !== BUILD_STAMP_SCHEMA_VERSION) {
    return stampError('go_core_build_unverified', 'unsupported build stamp schema');
  }
  let binaryHash;
  try {
    binaryHash = sha256Hex(fs.readFileSync(binaryPath));
  } catch (_error) {
    return stampError('go_core_build_unverified', 'binary unreadable');
  }
  if (binaryHash !== stamp.binary_sha256) {
    return stampError('go_core_build_mismatch', 'binary does not match its build stamp');
  }
  if (options.expectedVersion && stamp.version !== options.expectedVersion) {
    return stampError('go_core_build_mismatch', `built for ${stamp.version}, host is ${options.expectedVersion}`);
  }
  if (options.expectedRouteManifestHash && stamp.route_manifest_sha256 !== options.expectedRouteManifestHash) {
    return stampError('go_core_build_mismatch', 'route ownership manifest changed since the build');
  }
  return { ok: true, code: '', stamp };
}

module.exports = {
  BUILD_STAMP_SCHEMA_VERSION,
  buildStampPath,
  computeRouteManifestHash,
  readPackageVersion,
  sha256Hex,
  verifyBuildStamp,
  writeBuildStamp
};
