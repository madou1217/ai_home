'use strict';

const crypto = require('node:crypto');
const store = require('../server/account-credential-store');

function credentialVersion(record) {
  if (!record) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    env: record.env,
    nativeAuth: record.nativeAuth,
    envUpdatedAt: record.envUpdatedAt,
    nativeAuthUpdatedAt: record.nativeAuthUpdatedAt
  })).digest('hex');
}

/** Capture before the network request: completion order is not credential freshness. */
function snapshotKiroCredentialVersions(fs, aiHomeDir) {
  if (!aiHomeDir) return null;
  return new Map(store.listAccountCredentialRecords(fs, aiHomeDir, 'kiro')
    .map(record => [record.accountRef, credentialVersion(record)]));
}

function matchesKiroCredentialVersion(record, expectedVersions) {
  if (!(expectedVersions instanceof Map)) return false;
  if (!record) return true;
  return expectedVersions.get(record.accountRef) === credentialVersion(record);
}

module.exports = { snapshotKiroCredentialVersions, matchesKiroCredentialVersion };
