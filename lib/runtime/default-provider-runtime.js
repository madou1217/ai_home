'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { resolveNativeCliPath } = require('./native-cli-resolver');
const { probeProviderRuntimeVersion } = require('./provider-runtime-version');

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function defaultHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashValue(hash, value) {
  return normalizeText(hash(value));
}

function resolveRealPath(fsImpl, executablePath) {
  try {
    return normalizeText(fsImpl.realpathSync(executablePath)) || executablePath;
  } catch (_error) {
    return executablePath;
  }
}

function fileRevision(stat) {
  return JSON.stringify([
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs
  ].map((value) => normalizeText(value)));
}

function readFileStat(fsImpl, realPath) {
  if (typeof fsImpl.statSync !== 'function') return null;
  try {
    const stat = fsImpl.statSync(realPath);
    if (typeof stat.isFile === 'function' && !stat.isFile()) return false;
    return stat;
  } catch (_error) {
    return false;
  }
}

function readBinarySnapshot(fsImpl, realPath, hash) {
  try {
    const content = fsImpl.readFileSync(realPath);
    const prefix = Buffer.isBuffer(content) ? content.subarray(0, 160) : String(content).slice(0, 160);
    return {
      binaryHash: hashValue(hash, content),
      filePrefix: Buffer.isBuffer(prefix) ? prefix.toString('utf8') : prefix
    };
  } catch (_error) {
    return { binaryHash: '', filePrefix: '' };
  }
}

function inspectBinary(fsImpl, realPath, hash, cache) {
  const stat = readFileStat(fsImpl, realPath);
  if (stat === false) return { exists: false, binaryHash: '', fileRevision: 'missing' };
  const revision = stat ? fileRevision(stat) : 'unavailable';
  const cached = cache.get(realPath);
  if (cached && cached.fileRevision === revision) return cached;
  const binary = readBinarySnapshot(fsImpl, realPath, hash);
  const snapshot = {
    exists: Boolean(stat || binary.binaryHash),
    ...binary,
    fileRevision: revision
  };
  if (binary.binaryHash) cache.set(realPath, snapshot);
  return snapshot;
}

function runtimeIdentity(descriptor, fileIdentity) {
  return JSON.stringify([
    descriptor.provider,
    descriptor.runtimeScope,
    descriptor.executablePath,
    descriptor.realPath,
    descriptor.version,
    descriptor.binaryHash,
    fileIdentity,
    descriptor.protocolVersion,
    descriptor.capabilityHash,
    descriptor.authRevision
  ]);
}

function runtimeNotFound(provider) {
  const error = new Error(`Default runtime for provider '${provider}' was not found.`);
  error.code = 'provider_runtime_not_found';
  return error;
}

class DefaultProviderRuntimeResolver {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.spawn = options.spawn || spawn;
    this.spawnSync = options.spawnSync || spawnSync;
    this.hash = options.hash || defaultHash;
    this.resolveExecutable = options.resolveNativeCliPath || resolveNativeCliPath;
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env || {};
    this.nodeExecutable = options.nodeExecutable || process.execPath;
    this.powershellExecutable = options.powershellExecutable || 'powershell.exe';
    this.versionProbeTimeoutMs = options.versionProbeTimeoutMs;
    this.nativeCliOptions = {
      projectFallback: false,
      ...(options.nativeCliOptions || {}),
      ...(options.spawnSync ? { spawnSyncImpl: this.spawnSync } : {})
    };
    this.binaryCache = new Map();
    this.versionProbeCache = new Map();
    this.runtimeCache = new Map();
  }

  async resolve(provider, context = {}) {
    const normalizedProvider = normalizeText(provider).toLowerCase();
    if (!normalizedProvider) throw new TypeError('provider is required');
    const executablePath = normalizeText(this.resolveExecutable(normalizedProvider, {
      ...this.nativeCliOptions,
      env: this.env,
      fs: this.fs,
      platform: this.platform
    }));
    if (!executablePath) throw runtimeNotFound(normalizedProvider);
    return this.createDescriptor(normalizedProvider, executablePath, context);
  }

  async createDescriptor(provider, executablePath, context) {
    const realPath = resolveRealPath(this.fs, executablePath);
    const binary = inspectBinary(this.fs, realPath, this.hash, this.binaryCache);
    if (!binary.exists) throw runtimeNotFound(provider);
    const version = await this.resolveVersion(realPath, binary);
    if (!this.isCurrentBinary(executablePath, realPath, binary.fileRevision)) {
      return this.createDescriptor(provider, executablePath, context);
    }
    const values = {
      provider,
      runtimeScope: normalizeText(context.runtimeScope) || 'global',
      executablePath,
      realPath,
      version,
      binaryHash: binary.binaryHash,
      protocolVersion: normalizeText(context.protocolVersion),
      capabilityHash: normalizeText(context.capabilityHash),
      authRevision: normalizeText(context.authRevision)
    };
    const identity = runtimeIdentity(values, binary.fileRevision);
    const cacheKey = JSON.stringify([provider, values.runtimeScope]);
    const cached = this.runtimeCache.get(cacheKey);
    if (cached && cached.identity === identity) return cached.descriptor;
    const descriptor = Object.freeze({
      ...values,
      fingerprint: hashValue(this.hash, identity),
      generation: cached ? cached.descriptor.generation + 1 : 1
    });
    this.runtimeCache.set(cacheKey, { identity, descriptor });
    return descriptor;
  }

  resolveVersion(realPath, binary) {
    const cached = this.versionProbeCache.get(realPath);
    if (cached && cached.fileRevision === binary.fileRevision) return cached.pending;
    const pending = probeProviderRuntimeVersion(realPath, binary.filePrefix, this)
      .catch(() => '');
    this.versionProbeCache.set(realPath, {
      fileRevision: binary.fileRevision,
      pending
    });
    return pending;
  }

  isCurrentBinary(executablePath, realPath, expectedRevision) {
    if (resolveRealPath(this.fs, executablePath) !== realPath) return false;
    const current = inspectBinary(this.fs, realPath, this.hash, this.binaryCache);
    return current.exists && current.fileRevision === expectedRevision;
  }
}
module.exports = {
  DefaultProviderRuntimeResolver
};
