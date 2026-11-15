'use strict';

// Restore has an integrity preflight boundary: validate every referenced object before
// handing any records to the importer. Hashes detect inconsistency, not a
// malicious server that can rewrite both the manifest and its objects.
const { TextDecoder } = require('node:util');
const crypto = require('node:crypto');
const { hashAccount, stableStringify, MANIFEST_KIND, MANIFEST_VERSION, ACCOUNT_DOCUMENT_KIND, ACCOUNT_DOCUMENT_VERSION, accountRelativePath } = require('./remote-backup-manifest');

function integrityError(code, accountRef) {
  const error = new Error(code);
  error.code = code;
  if (accountRef) error.accountRef = accountRef;
  return error;
}

function readVerifiedManifest(text) {
  if (text === null || text === undefined) return null;
  let raw;
  try {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  }
  catch (_error) { throw integrityError('backup_manifest_invalid'); }
  if (!raw || raw.kind !== MANIFEST_KIND || raw.version !== MANIFEST_VERSION) throw integrityError('backup_manifest_unsupported');
  if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)
    || !Number.isSafeInteger(raw.revision) || raw.revision < 0) throw integrityError('backup_manifest_invalid');
  for (const [ref, entry] of Object.entries(raw.accounts)) {
    if (!/^acct_[a-f0-9]{20}$/.test(ref)) throw integrityError('backup_manifest_invalid');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.provider !== 'string') throw integrityError('backup_manifest_invalid', ref);
    try { accountRelativePath(entry.provider, ref); } catch (_error) { throw integrityError('backup_manifest_invalid', ref); }
    if (entry.provider === '.' || entry.provider === '..' || entry.provider !== String(entry.provider).trim() || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || (Object.hasOwn(entry, 'deleted') && typeof entry.deleted !== 'boolean')) throw integrityError('backup_manifest_invalid', ref);
  }
  return raw;
}

function verifyBackupObject(content, ref, entry) {
  if (content === null || content === undefined) throw integrityError('backup_object_missing', ref);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (bytes.length !== entry.bytes) throw integrityError('backup_object_bytes_mismatch', ref);
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch (_error) { throw integrityError('backup_object_invalid', ref); }
  if (!document || document.kind !== ACCOUNT_DOCUMENT_KIND || document.version !== ACCOUNT_DOCUMENT_VERSION
    || !Array.isArray(document.accounts) || document.accounts.length !== 1) throw integrityError('backup_object_invalid', ref);
  const record = document.accounts[0];
  if (!record || record.accountRef !== ref || record.provider !== entry.provider) throw integrityError('backup_object_identity_mismatch', ref);
  if (hashAccount(record) !== entry.sha256) {
    // Legacy Go v1 escaped these JSON string separators even with HTML escaping
    // disabled. Accept that exact historical encoding, not arbitrary documents.
    const goV1 = stableStringify(record).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const legacyHash = crypto.createHash('sha256').update(goV1).digest('hex');
    if (legacyHash !== entry.sha256) throw integrityError('backup_object_hash_mismatch', ref);
  }
  return record;
}

module.exports = { integrityError, readVerifiedManifest, verifyBackupObject };
