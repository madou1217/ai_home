'use strict';

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');

function buildTransferMetadataKey(accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  return isAccountRef(normalizedRef) ? `account:transfer:${normalizedRef}` : '';
}

function readTransferMetadata(fs, aiHomeDir, accountRef) {
  const key = buildTransferMetadataKey(accountRef);
  if (!key) return {};
  const value = readJsonValue(fs, aiHomeDir, key);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function writeTransferMetadata(fs, aiHomeDir, accountRef, metadata) {
  const normalizedRef = String(accountRef || '').trim();
  const account = isAccountRef(normalizedRef)
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account) throw new Error('invalid_transfer_metadata_account');
  const key = buildTransferMetadataKey(normalizedRef);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length === 0) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  if (!writeJsonValue(fs, aiHomeDir, key, metadata)) {
    throw new Error('transfer_metadata_write_failed');
  }
  return true;
}

function deleteTransferMetadata(fs, aiHomeDir, accountRef) {
  const key = buildTransferMetadataKey(accountRef);
  return key ? deleteJsonValue(fs, aiHomeDir, key) : false;
}

module.exports = {
  buildTransferMetadataKey,
  deleteTransferMetadata,
  readTransferMetadata,
  writeTransferMetadata
};
