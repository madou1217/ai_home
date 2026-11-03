'use strict';

// 发布目标矩阵的唯一声明处。artifact 命名、Go 交叉编译参数、Node 发行包文件名
// 都从这里派生，避免打包脚本里散落平台字符串。

const TARGETS = Object.freeze([
  Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS (Apple Silicon)',
    nodeDist: 'darwin-arm64',
    goos: 'darwin',
    goarch: 'arm64'
  }),
  Object.freeze({
    platform: 'darwin',
    arch: 'x64',
    label: 'macOS (Intel)',
    nodeDist: 'darwin-x64',
    goos: 'darwin',
    goarch: 'amd64'
  }),
  Object.freeze({
    platform: 'linux',
    arch: 'x64',
    label: 'Linux (x64)',
    nodeDist: 'linux-x64',
    goos: 'linux',
    goarch: 'amd64'
  }),
  Object.freeze({
    platform: 'linux',
    arch: 'arm64',
    label: 'Linux (arm64)',
    nodeDist: 'linux-arm64',
    goos: 'linux',
    goarch: 'arm64'
  }),
  Object.freeze({
    platform: 'win32',
    arch: 'x64',
    label: 'Windows (x64)',
    nodeDist: 'win-x64',
    goos: 'windows',
    goarch: 'amd64'
  }),
  Object.freeze({
    platform: 'win32',
    arch: 'arm64',
    label: 'Windows (arm64)',
    nodeDist: 'win-arm64',
    goos: 'windows',
    goarch: 'arm64'
  })
]);

function targetKey(target) {
  return `${target.platform}-${target.arch}`;
}

function isWindows(target) {
  return target.platform === 'win32';
}

function normalizeTarget(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return TARGETS.find((target) => targetKey(target) === text) || null;
}

function hostTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const found = TARGETS.find((target) => targetKey(target) === key);
  if (!found) throw new Error(`unsupported host target: ${key}`);
  return found;
}

/**
 * 解析 --targets。支持 host、all、逗号分隔的 `<platform>-<arch>`。
 * 空值等同于 host；未知目标直接失败，不静默跳过。
 */
function parseTargets(value, options = {}) {
  const text = String(value || '').trim();
  if (!text || text === 'host') return [options.host || hostTarget()];
  if (text === 'all') return [...TARGETS];
  const seen = new Set();
  const targets = [];
  for (const part of text.split(',')) {
    const normalized = part.trim();
    if (!normalized) continue;
    const target = normalizeTarget(normalized);
    if (!target) throw new Error(`unknown --targets entry: ${normalized}`);
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  if (targets.length === 0) throw new Error('--targets resolved to no targets');
  return targets;
}

function nodeDistributionFile(target, nodeVersion) {
  const version = String(nodeVersion || '').replace(/^v/, '');
  return isWindows(target)
    ? `node-v${version}-${target.nodeDist}.zip`
    : `node-v${version}-${target.nodeDist}.tar.gz`;
}

function artifactBaseName(version, target) {
  return `aih-${version}-${targetKey(target)}`;
}

module.exports = {
  TARGETS,
  artifactBaseName,
  hostTarget,
  isWindows,
  nodeDistributionFile,
  normalizeTarget,
  parseTargets,
  targetKey
};
