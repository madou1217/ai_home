'use strict';

const nodePath = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const {
  hasUsableKimiOAuth,
  readKimiOAuthCredentials,
  readKimiTokenDeviceId,
  readKimiTokenExpiry,
  resolveKimiOAuthDeviceId
} = require('./kimi-auth');
const { readProviderAuthProjection } = require('./native-auth-projection');

function readMtimeMs(fs, filePath) {
  try {
    return Number(fs.statSync(filePath).mtimeMs) || 0;
  } catch (_error) {
    return 0;
  }
}

function readKimiHostCredentialRecord(fs, hostHomeDir, pathImpl = nodePath) {
  const root = String(hostHomeDir || '').trim();
  if (!fs || !root) return null;

  const projection = readProviderAuthProjection(fs, root, 'kimi', { path: pathImpl });
  const credentials = projection && projection.credentials;
  if (!hasUsableKimiOAuth(credentials)) return null;

  const tokenDeviceId = readKimiTokenDeviceId(credentials);
  const fileDeviceId = String(projection.deviceId || '').trim();
  if (fileDeviceId && tokenDeviceId && fileDeviceId !== tokenDeviceId) {
    return {
      ok: false,
      reason: 'host_device_id_mismatch'
    };
  }

  const credentialsPath = pathImpl.join(root, '.kimi-code', 'credentials', 'kimi-code.json');
  const deviceIdPath = pathImpl.join(root, '.kimi-code', 'device_id');
  return {
    ok: true,
    credentials,
    deviceId: fileDeviceId || tokenDeviceId,
    credentialsModifiedAtMs: readMtimeMs(fs, credentialsPath),
    deviceModifiedAtMs: readMtimeMs(fs, deviceIdPath),
    modifiedAtMs: Math.max(
      readMtimeMs(fs, credentialsPath),
      readMtimeMs(fs, deviceIdPath)
    )
  };
}

function createKimiHostCredentialReconciler(deps = {}) {
  const fs = deps.fs;
  const path = deps.path || nodePath;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();

  return function reconcileKimiHostCredentials(accountRef) {
    const normalizedAccountRef = String(accountRef || '').trim();
    if (!fs || !aiHomeDir || !hostHomeDir || !normalizedAccountRef) {
      return { ok: true, adopted: false, reason: 'host_reconciliation_unavailable' };
    }

    const record = readAccountCredentialRecord(fs, aiHomeDir, normalizedAccountRef);
    if (!record || record.provider !== 'kimi') {
      return { ok: true, adopted: false, reason: 'unknown_account_ref' };
    }

    const currentCredentials = readKimiOAuthCredentials(record.nativeAuth);
    if (!hasUsableKimiOAuth(currentCredentials)) {
      return { ok: true, adopted: false, reason: 'database_credentials_incomplete' };
    }

    const hostRecord = readKimiHostCredentialRecord(fs, hostHomeDir, path);
    if (!hostRecord) {
      return { ok: true, adopted: false, reason: 'host_credentials_missing' };
    }
    if (hostRecord.ok === false) return hostRecord;

    const databaseIdentity = resolveNativeAuthIdentitySeed('kimi', {
      credentials: currentCredentials
    });
    const hostIdentity = resolveNativeAuthIdentitySeed('kimi', {
      credentials: hostRecord.credentials
    });
    if (!databaseIdentity.identitySeed || databaseIdentity.degraded
      || !hostIdentity.identitySeed || hostIdentity.degraded) {
      return { ok: true, adopted: false, reason: 'stable_identity_unavailable' };
    }
    if (databaseIdentity.identitySeed !== hostIdentity.identitySeed) {
      return { ok: true, adopted: false, reason: 'host_identity_mismatch' };
    }

    const currentDeviceId = resolveKimiOAuthDeviceId(record.nativeAuth);
    const hostDeviceId = String(hostRecord.deviceId || '').trim();
    const credentialsChanged = !isDeepStrictEqual(currentCredentials, hostRecord.credentials);
    const hostMtimeIsNewer = hostRecord.modifiedAtMs > Number(record.nativeAuthUpdatedAt || 0);
    const hostExpiryIsNewer = readKimiTokenExpiry(hostRecord.credentials)
      > readKimiTokenExpiry(currentCredentials);
    const shouldAdoptCredentials = credentialsChanged && (hostMtimeIsNewer || hostExpiryIsNewer);
    // device_id is part of the token's device binding. Do not pair an older
    // host token with a newer/different host device file; adopt the device only
    // when the token snapshot is current or is being adopted as a whole.
    const shouldAdoptDeviceId = Boolean(
      hostDeviceId
      && hostDeviceId !== currentDeviceId
      && (!credentialsChanged || shouldAdoptCredentials)
    );

    if (!shouldAdoptCredentials && !shouldAdoptDeviceId) {
      return {
        ok: true,
        adopted: false,
        reason: credentialsChanged ? 'host_snapshot_not_newer' : 'host_snapshot_current'
      };
    }

    const nextNativeAuth = {
      ...record.nativeAuth,
      ...(shouldAdoptCredentials ? { credentials: hostRecord.credentials } : {}),
      ...(hostDeviceId ? { deviceId: hostDeviceId } : {})
    };
    if (shouldAdoptCredentials) delete nextNativeAuth.auth;
    writeAccountNativeAuth(fs, aiHomeDir, normalizedAccountRef, nextNativeAuth);
    return {
      ok: true,
      adopted: true,
      reason: shouldAdoptCredentials ? 'host_credentials_newer' : 'host_device_id_current',
      accountRef: normalizedAccountRef,
      hostModifiedAtMs: hostRecord.modifiedAtMs
    };
  };
}

module.exports = {
  createKimiHostCredentialReconciler,
  hasUsableKimiOAuth,
  readKimiHostCredentialRecord
};
