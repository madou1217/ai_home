'use strict';

const nativeFs = require('node:fs');
const nativeOs = require('node:os');
const nativePath = require('node:path');

const {
  atomicWritePrivateFile,
  ensurePrivateDirectory
} = require('../cli/services/toolkit/proxy-pool/secure-file-io');

const DEFAULT_PENDING_TTL_MS = 60 * 1000;

function storeError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createInitialData() {
  return { version: 1, leases: [], groupState: {} };
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

class ZcodeEgressLeaseStore {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    const aiHomeDir = String(
      options.aiHomeDir
      || process.env.AIH_HOME
      || this.path.join(nativeOs.homedir(), '.ai_home')
    ).trim();
    this.filePath = options.filePath || this.path.join(aiHomeDir, 'run', 'zcode-egress-leases.json');
    this.lockPath = `${this.filePath}.lock`;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.isProcessAlive = typeof options.isProcessAlive === 'function'
      ? options.isProcessAlive
      : defaultIsProcessAlive;
    this.pendingTtlMs = Math.max(100, Number(options.pendingTtlMs || DEFAULT_PENDING_TTL_MS));
    this._ensureStore();
  }

  _ensureStore() {
    ensurePrivateDirectory(this.fs, this.path.dirname(this.filePath));
    if (!this.fs.existsSync(this.filePath)) this._write(createInitialData());
  }

  _read() {
    this._ensureStore();
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw storeError('zcode_egress_lease_store_corrupt', error);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw storeError('zcode_egress_lease_store_corrupt');
    }
    return {
      version: 1,
      leases: Array.isArray(parsed.leases) ? parsed.leases : [],
      groupState: parsed.groupState && typeof parsed.groupState === 'object' && !Array.isArray(parsed.groupState)
        ? parsed.groupState
        : {}
    };
  }

  _write(data) {
    atomicWritePrivateFile(
      this.fs,
      this.path,
      this.filePath,
      `${JSON.stringify(data, null, 2)}\n`
    );
  }

  _acquireLock() {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        const descriptor = this.fs.openSync(this.lockPath, 'wx', 0o600);
        this.fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return descriptor;
      } catch (error) {
        if (error.code !== 'EEXIST') throw storeError('zcode_egress_lease_store_busy', error);
        if (Date.now() >= deadline) throw storeError('zcode_egress_lease_store_busy', error);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  _releaseLock(descriptor) {
    try { this.fs.closeSync(descriptor); } finally {
      try { this.fs.unlinkSync(this.lockPath); } catch (_error) {}
    }
  }

  _mutate(mutator) {
    const descriptor = this._acquireLock();
    try {
      const data = this._read();
      const result = mutator(data);
      this._write(data);
      return result;
    } finally {
      this._releaseLock(descriptor);
    }
  }

  _isActive(lease, now) {
    const pid = Number(lease && lease.pid);
    if (Number.isInteger(pid) && pid > 0) return this.isProcessAlive(pid);
    return Number(lease && lease.expiresAt) > now;
  }

  _prune(data) {
    const now = Number(this.now());
    const before = data.leases.length;
    data.leases = data.leases.filter((lease) => this._isActive(lease, now));
    return before !== data.leases.length;
  }

  listActive() {
    return this._mutate((data) => {
      this._prune(data);
      return data.leases.map((lease) => ({ ...lease }));
    });
  }

  getByOwner(ownerId) {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) return null;
    return this._mutate((data) => {
      this._prune(data);
      const lease = data.leases.find((candidate) => candidate.ownerId === normalizedOwnerId);
      return lease ? { ...lease } : null;
    });
  }

  acquire(input = {}) {
    const ownerId = String(input.ownerId || '').trim();
    const nodeId = String(input.nodeId || '').trim();
    if (!ownerId || !nodeId) throw storeError('invalid_zcode_egress_lease');
    const accountRef = String(input.accountRef || '').trim();
    const instanceKind = String(input.instanceKind || '').trim().toLowerCase() || 'desktop';
    const groupId = String(input.groupId || '').trim();
    return this._mutate((data) => {
      this._prune(data);
      const now = Number(this.now());
      const index = data.leases.findIndex((lease) => lease.ownerId === ownerId);
      const previous = index >= 0 ? data.leases[index] : null;
      const pid = Number.isInteger(Number(input.pid)) && Number(input.pid) > 0
        ? Number(input.pid)
        : (Number.isInteger(Number(previous?.pid)) && Number(previous.pid) > 0 ? Number(previous.pid) : null);
      const lease = {
        ownerId,
        accountRef,
        instanceKind,
        groupId,
        nodeId,
        pid,
        acquiredAt: previous?.acquiredAt || now,
        updatedAt: now,
        expiresAt: pid ? null : now + this.pendingTtlMs
      };
      if (index === -1) data.leases.push(lease);
      else data.leases[index] = lease;
      if (groupId) {
        data.groupState[groupId] = { lastSelectedNodeId: nodeId, updatedAt: now };
      }
      return { ...lease };
    });
  }

  attachProcess(ownerId, pid) {
    const normalizedOwnerId = String(ownerId || '').trim();
    const normalizedPid = Number(pid);
    if (!normalizedOwnerId || !Number.isInteger(normalizedPid) || normalizedPid <= 0) {
      throw storeError('invalid_zcode_egress_lease_process');
    }
    return this._mutate((data) => {
      this._prune(data);
      const lease = data.leases.find((candidate) => candidate.ownerId === normalizedOwnerId);
      if (!lease) return null;
      lease.pid = normalizedPid;
      lease.updatedAt = Number(this.now());
      lease.expiresAt = null;
      return { ...lease };
    });
  }

  release(ownerId) {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) return false;
    return this._mutate((data) => {
      const before = data.leases.length;
      data.leases = data.leases.filter((lease) => lease.ownerId !== normalizedOwnerId);
      return data.leases.length !== before;
    });
  }

  releaseByAccount(accountRef) {
    const normalizedRef = String(accountRef || '').trim();
    if (!normalizedRef) return 0;
    return this._mutate((data) => {
      const before = data.leases.length;
      data.leases = data.leases.filter((lease) => lease.accountRef !== normalizedRef);
      return before - data.leases.length;
    });
  }

  getLastSelectedNodeId(groupId) {
    const id = String(groupId || '').trim();
    if (!id) return '';
    const data = this._read();
    return String(data.groupState[id]?.lastSelectedNodeId || '');
  }
}

const defaultStores = new Map();

function getZcodeEgressLeaseStore(options = {}) {
  const hasCustomDependencies = Boolean(
    options.filePath
    || options.fs
    || options.path
    || options.now
    || options.isProcessAlive
    || options.pendingTtlMs
  );
  if (hasCustomDependencies) return new ZcodeEgressLeaseStore(options);
  const aiHomeDir = String(
    options.aiHomeDir
    || process.env.AIH_HOME
    || nativePath.join(nativeOs.homedir(), '.ai_home')
  ).trim();
  if (!defaultStores.has(aiHomeDir)) {
    defaultStores.set(aiHomeDir, new ZcodeEgressLeaseStore({ aiHomeDir }));
  }
  return defaultStores.get(aiHomeDir);
}

module.exports = {
  ZcodeEgressLeaseStore,
  getZcodeEgressLeaseStore
};
