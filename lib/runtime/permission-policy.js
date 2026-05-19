'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveHostHomeDir } = require('./host-home');

const POLICY_VERSION = 1;
const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  updatedAt: '',
  exec: {
    defaultSandbox: 'workspace-write',
    allowDangerFullAccess: false
  }
});

function clonePolicy(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSandbox(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'danger-full-access') return 'danger-full-access';
  if (normalized === 'read-only') return 'read-only';
  return 'workspace-write';
}

function normalizePolicy(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const exec = (src.exec && typeof src.exec === 'object') ? src.exec : {};
  const updatedAt = String(src.updatedAt || '').trim();

  return {
    version: POLICY_VERSION,
    updatedAt,
    exec: {
      defaultSandbox: normalizeSandbox(exec.defaultSandbox),
      allowDangerFullAccess: Boolean(exec.allowDangerFullAccess)
    }
  };
}

function resolvePolicyPath(options = {}) {
  const pathImpl = options.path || path;
  if (options.policyFile) {
    return String(options.policyFile);
  }
  const hostHomeDir = resolveHostHomeDir({
    env: options.env || process.env,
    platform: options.platform || process.platform,
    os: options.os
  });
  const aiHomeDir = String(options.aiHomeDir || pathImpl.join(hostHomeDir, '.ai_home'));
  return pathImpl.join(aiHomeDir, 'policy', 'exec-permission-policy.json');
}

function loadPermissionPolicy(options = {}) {
  const fsImpl = options.fs || fs;
  const policyPath = resolvePolicyPath(options);
  if (!fsImpl.existsSync(policyPath)) {
    return clonePolicy(DEFAULT_POLICY);
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(policyPath, 'utf8'));
    return normalizePolicy(parsed);
  } catch (_error) {
    return clonePolicy(DEFAULT_POLICY);
  }
}

function savePermissionPolicy(nextPolicy, options = {}) {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const policyPath = resolvePolicyPath(options);
  const normalized = normalizePolicy(nextPolicy);
  normalized.updatedAt = new Date().toISOString();

  fsImpl.mkdirSync(pathImpl.dirname(policyPath), { recursive: true });
  fsImpl.writeFileSync(policyPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

function shouldUseDangerFullAccess(policy) {
  const normalized = normalizePolicy(policy);
  return normalized.exec.defaultSandbox === 'danger-full-access'
    && normalized.exec.allowDangerFullAccess === true;
}

module.exports = {
  DEFAULT_POLICY,
  POLICY_VERSION,
  loadPermissionPolicy,
  normalizePolicy,
  resolvePolicyPath,
  savePermissionPolicy,
  shouldUseDangerFullAccess
};
