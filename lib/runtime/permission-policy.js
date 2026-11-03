'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveHostHomeDir } = require('./host-home');
const {
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');

const POLICY_VERSION = 1;
const PERMISSION_POLICY_KEY = 'policy:exec';
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

function resolvePolicyAiHomeDir(options = {}) {
  const pathImpl = options.path || path;
  const hostHomeDir = resolveHostHomeDir({
    env: options.env || process.env,
    platform: options.platform || process.platform,
    os: options.os
  });
  return String(options.aiHomeDir || pathImpl.join(hostHomeDir, '.ai_home')).trim();
}

function loadPermissionPolicy(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = resolvePolicyAiHomeDir(options);
  const stored = readJsonValue(fsImpl, aiHomeDir, PERMISSION_POLICY_KEY);
  return stored && typeof stored === 'object'
    ? normalizePolicy(stored)
    : clonePolicy(DEFAULT_POLICY);
}

function savePermissionPolicy(nextPolicy, options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = resolvePolicyAiHomeDir(options);
  const normalized = normalizePolicy(nextPolicy);
  normalized.updatedAt = new Date().toISOString();

  if (!writeJsonValue(fsImpl, aiHomeDir, PERMISSION_POLICY_KEY, normalized)) {
    throw new Error('permission_policy_write_failed');
  }
  return normalized;
}

function shouldUseDangerFullAccess(policy) {
  const normalized = normalizePolicy(policy);
  return normalized.exec.defaultSandbox === 'danger-full-access'
    && normalized.exec.allowDangerFullAccess === true;
}

module.exports = {
  DEFAULT_POLICY,
  PERMISSION_POLICY_KEY,
  POLICY_VERSION,
  loadPermissionPolicy,
  normalizePolicy,
  resolvePolicyAiHomeDir,
  savePermissionPolicy,
  shouldUseDangerFullAccess
};
