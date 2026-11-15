'use strict';

// v2 has an explicit canonical encoding, unlike the historical v1 record hash.
// Validate the supported JSON domain before serialization; never coerce secrets
// or unsafe integral numbers to strings merely to obtain an interoperable hash.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const layout = require('../../../contracts/backuprepository/format.json');
const { stableStringify, accountRelativePath } = require('./remote-backup-manifest');
const { integrityError } = require('./remote-backup-integrity');

function validateValue(value, depth = 0) {
  if (depth > 100) throw integrityError('backup_json_depth');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw integrityError('backup_unsafe_number');
    return;
  }
  if (typeof value === 'string') {
    // Do not require recent String.isWellFormed on otherwise supported Node
    // runtimes; reject unpaired UTF-16 code units without changing string data.
    for (let i = 0; i < value.length; i += 1) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw integrityError('backup_invalid_unicode');
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw integrityError('backup_invalid_unicode');
    }
    return;
  }
  if (Array.isArray(value)) { for (const item of value) validateValue(item, depth + 1); return; }
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw integrityError('backup_invalid_json_value');
  for (const [key, item] of Object.entries(value)) { validateValue(key, depth + 1); validateValue(item, depth + 1); }
}
function canonical(value) { validateValue(value); return stableStringify(value); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function objectPath(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw integrityError('backup_invalid_object_hash');
  return `${layout.objectsPrefix}${hash}.json`;
}
function createObject(record) {
  if (!record || !/^acct_[a-f0-9]{20}$/.test(record.accountRef) || typeof record.provider !== 'string' || record.provider === '.' || record.provider === '..') throw integrityError('backup_object_identity_mismatch');
  accountRelativePath(record.provider, record.accountRef);
  const bytes = Buffer.from(`${canonical({ kind: 'aih-accounts', version: 1, accounts: [record] })}\n`);
  if (bytes.length > layout.maxObjectBytes) throw integrityError('backup_object_too_large');
  return { content: bytes, path: objectPath(digest(bytes)), entry: { provider: record.provider, objectSha256: digest(bytes), bytes: bytes.length } };
}
function verifyObject(bytes, ref, entry) {
  if (!Buffer.isBuffer(bytes)) throw integrityError('backup_object_missing', ref);
  if (bytes.length !== entry.bytes || bytes.length > layout.maxObjectBytes) throw integrityError('backup_object_bytes_mismatch', ref);
  if (digest(bytes) !== entry.objectSha256) throw integrityError('backup_object_hash_mismatch', ref);
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (_error) { throw integrityError('backup_object_invalid', ref); }
  // Equality also rejects duplicate keys, noncanonical number tokens and JSON
  // that would silently change under the Node importer's numeric semantics.
  if (!bytes.equals(Buffer.from(`${canonical(doc)}\n`))) throw integrityError('backup_object_encoding_mismatch', ref);
  if (!doc || typeof doc !== 'object' || doc.kind !== 'aih-accounts' || doc.version !== 1 || !Array.isArray(doc.accounts) || doc.accounts.length !== 1) throw integrityError('backup_object_invalid', ref);
  const record = doc.accounts[0];
  if (!record || typeof record !== 'object' || record.accountRef !== ref || record.provider !== entry.provider) throw integrityError('backup_object_identity_mismatch', ref);
  return record;
}
module.exports = { layout, canonical, digest, objectPath, createObject, verifyObject };
