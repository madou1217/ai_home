'use strict';

const nodePath = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  readClaudeKeychainCredentialRecord,
  writeClaudeKeychainCredentials
} = require('./claude-keychain');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { writeAccountNativeAuth } = require('../server/account-credential-store');

function readClaudeOAuth(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return {};
  const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth;
  return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : {};
}

function hasUsableClaudeOAuth(credentials) {
  const oauth = readClaudeOAuth(credentials);
  const accessToken = String(oauth.accessToken || oauth.access_token || '').trim();
  const refreshToken = String(oauth.refreshToken || oauth.refresh_token || '').trim();
  return Boolean(accessToken && refreshToken);
}

function resolveClaudeIdentity(credentials) {
  const identity = resolveNativeAuthIdentitySeed('claude', { credentials });
  return identity && identity.degraded === false ? String(identity.identitySeed || '') : '';
}

function buildDatabaseResult(credentials, reason, keychainUpdated = false) {
  return {
    ok: true,
    credentials,
    source: 'database',
    reason,
    keychainUpdated,
    databaseUpdated: false
  };
}

function resolveDatabaseProjectionReason(databaseCredentials, keychainCredentials) {
  if (!hasUsableClaudeOAuth(keychainCredentials)) return 'keychain_credentials_incomplete';
  const databaseIdentity = resolveClaudeIdentity(databaseCredentials);
  const keychainIdentity = resolveClaudeIdentity(keychainCredentials);
  if (!databaseIdentity || !keychainIdentity) return 'keychain_identity_unverified';
  return databaseIdentity === keychainIdentity
    ? 'database_not_older'
    : 'keychain_identity_mismatch';
}

function shouldAdoptKeychainCredentials(record, keychainRecord) {
  if (!hasUsableClaudeOAuth(keychainRecord.credentials)) return false;
  const databaseIdentity = resolveClaudeIdentity(record.nativeAuth.credentials);
  const keychainIdentity = resolveClaudeIdentity(keychainRecord.credentials);
  return Boolean(databaseIdentity && databaseIdentity === keychainIdentity)
    && Number(keychainRecord.modifiedAtMs) > Number(record.nativeAuthUpdatedAt);
}

function createClaudeHostCredentialReconciler(deps = {}) {
  const processObj = deps.processObj || process;
  const path = deps.path || nodePath;
  const readKeychain = deps.readClaudeKeychainCredentialRecord || readClaudeKeychainCredentialRecord;
  const writeKeychain = deps.writeClaudeKeychainCredentials || writeClaudeKeychainCredentials;
  const writeNativeAuth = deps.writeAccountNativeAuth || writeAccountNativeAuth;

  function projectDatabaseCredentials(record, credentials, configDir, reason) {
    const result = writeKeychain(credentials, {
      processObj,
      configDir,
      includeDefaultService: false,
      execFileSync: deps.execFileSync
    });
    if (!result || !result.ok) {
      return { ok: false, reason: 'keychain_write_failed' };
    }
    return buildDatabaseResult(credentials, reason, true);
  }

  function adoptKeychainCredentials(record, credentials) {
    writeNativeAuth(deps.fs, deps.aiHomeDir, record.accountRef, {
      ...record.nativeAuth,
      credentials
    });
    return {
      ok: true,
      credentials,
      source: 'keychain',
      reason: 'keychain_newer',
      keychainUpdated: false,
      databaseUpdated: true
    };
  }

  return function reconcileClaudeHostCredentials(record) {
    const credentials = record && record.nativeAuth && record.nativeAuth.credentials;
    if (!hasUsableClaudeOAuth(credentials)) {
      return { ok: false, reason: 'incomplete_claude_oauth' };
    }
    if (processObj.platform !== 'darwin') {
      return buildDatabaseResult(credentials, 'keychain_not_applicable');
    }

    const configDir = path.join(deps.hostHomeDir, '.claude');
    const keychainRecord = readKeychain({
      processObj,
      configDir,
      includeDefaultService: false,
      execFileSync: deps.execFileSync
    });
    if (!keychainRecord || !keychainRecord.credentials) {
      return projectDatabaseCredentials(record, credentials, configDir, 'keychain_missing');
    }
    if (isDeepStrictEqual(keychainRecord.credentials, credentials)) {
      return buildDatabaseResult(credentials, 'keychain_current');
    }
    if (shouldAdoptKeychainCredentials(record, keychainRecord)) {
      return adoptKeychainCredentials(record, keychainRecord.credentials);
    }
    const reason = resolveDatabaseProjectionReason(credentials, keychainRecord.credentials);
    return projectDatabaseCredentials(record, credentials, configDir, reason);
  };
}

module.exports = {
  createClaudeHostCredentialReconciler,
  hasUsableClaudeOAuth,
  resolveClaudeIdentity
};
