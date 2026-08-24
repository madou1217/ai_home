'use strict';

const crypto = require('node:crypto');
const nativeFs = require('node:fs');
const nativeOs = require('node:os');
const nativePath = require('node:path');

const {
  atomicWritePrivateFile,
  ensurePrivateDirectory
} = require('../cli/services/toolkit/proxy-pool/secure-file-io');

function stateError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createInitialState() {
  return {
    version: 1,
    controllerPort: null,
    controllerSecret: crypto.randomBytes(24).toString('hex'),
    portAssignments: {},
    accounts: {}
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) {
    throw stateError('zcode_sidecar_state_corrupt');
  }
  const controllerPort = raw.controllerPort === null
    ? null
    : Number(raw.controllerPort);
  if (controllerPort !== null && (!Number.isInteger(controllerPort) || controllerPort < 1024 || controllerPort > 65535)) {
    throw stateError('zcode_sidecar_state_corrupt');
  }
  const controllerSecret = String(raw.controllerSecret || '').trim();
  if (!controllerSecret) throw stateError('zcode_sidecar_state_corrupt');
  const portAssignments = raw.portAssignments && typeof raw.portAssignments === 'object' && !Array.isArray(raw.portAssignments)
    ? Object.fromEntries(Object.entries(raw.portAssignments).map(([accountRef, port]) => [accountRef, Number(port)]))
    : {};
  if (Object.values(portAssignments).some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw stateError('zcode_sidecar_state_corrupt');
  }
  const accounts = raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  return {
    version: 1,
    controllerPort,
    controllerSecret,
    portAssignments,
    accounts
  };
}

class ZcodeSingBoxStateStore {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    const aiHomeDir = String(
      options.aiHomeDir
      || process.env.AIH_HOME
      || this.path.join(nativeOs.homedir(), '.ai_home')
    ).trim();
    this.runtimeDir = options.runtimeDir || this.path.join(aiHomeDir, 'run', 'zcode-egress', 'sing-box');
    this.filePath = options.filePath || this.path.join(this.runtimeDir, 'state.json');
    this._ensure();
  }

  _ensure() {
    ensurePrivateDirectory(this.fs, this.path.dirname(this.filePath));
    if (!this.fs.existsSync(this.filePath)) this.write(createInitialState());
  }

  read() {
    this._ensure();
    try {
      return normalizeState(JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'zcode_sidecar_state_corrupt') throw error;
      throw stateError('zcode_sidecar_state_corrupt', error);
    }
  }

  write(state) {
    const normalized = normalizeState(state);
    atomicWritePrivateFile(
      this.fs,
      this.path,
      this.filePath,
      `${JSON.stringify(normalized, null, 2)}\n`
    );
    return normalized;
  }
}

module.exports = {
  ZcodeSingBoxStateStore,
  createInitialState
};
