'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getProviderCLIConfig } = require('../provider-catalog');
const { resolveHostHomeDir } = require('../runtime/host-home');

const MAX_BYTES = 1024 * 1024;
const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken'];
const cachedCredentials = new Map();

function hasWorkbuddyEncryptedCredentials(value) {
  return TOKEN_FIELDS.some((field) => value?.auth?.[field]?.$wbEncrypted === 1);
}

function base64(value, length) {
  if (typeof value !== 'string' || value.length > MAX_BYTES) throw new Error('invalid_encrypted_credential');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || length != null && bytes.length !== length) {
    bytes.fill(0);
    throw new Error('invalid_encrypted_credential');
  }
  return bytes;
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

// Official WorkBuddy sym-v1 field framing (WBEV1), not Electron safeStorage.
// Keys remain inside the vendor Electron helper; only credentials cross its pipe.
function transformWorkbuddyCredentials(value, operation, keyPayload) {
  if (!['decode', 'encode'].includes(operation) || !value?.auth || keyPayload?.version !== 1) {
    throw new Error('invalid_encrypted_credential');
  }
  const secret = base64(keyPayload.atRestSecretKey, 32);
  if (secret.every((byte) => byte === 0)) { secret.fill(0); throw new Error('invalid_encryption_key'); }
  secret.fill(0);
  const key = crypto.createHash('sha256').update(keyPayload.atRestSecretKey, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const suite = Buffer.from([0, 0, 0, 1]);
  const aad = Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
    lengthPrefixed('WBEV1'), lengthPrefixed('sym-v1'), suite, lengthPrefixed(keyId), Buffer.from([2, 0, 0])]);
  const result = { ...value, auth: { ...value.auth } };
  try {
    for (const field of TOKEN_FIELDS) {
      const token = value.auth[field];
      if (operation === 'encode') {
        if (token == null) continue;
        if (typeof token !== 'string') throw new Error('invalid_encrypted_credential');
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        result.auth[field] = { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({
          suite: 1, keyId, nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64')
        })).toString('base64') };
        continue;
      }
      if (token == null || typeof token === 'string') continue;
      if (token.$wbEncrypted !== 1 || Object.keys(token).sort().join(',') !== '$wbEncrypted,envelope') {
        throw new Error('unsupported_encrypted_credential');
      }
      const envelopeBytes = base64(token.envelope);
      const envelope = JSON.parse(envelopeBytes.toString('utf8'));
      if (envelope.suite !== 1 || envelope.keyId !== keyId
        || Object.keys(envelope).sort().join(',') !== 'authTag,ciphertext,keyId,nonce,suite') {
        throw new Error('invalid_encrypted_credential');
      }
      const nonce = base64(envelope.nonce, 12), tag = base64(envelope.authTag, 16);
      const ciphertext = base64(envelope.ciphertext);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try { result.auth[field] = plaintext.toString('utf8'); } finally { plaintext.fill(0); }
    }
    return result;
  } finally { key.fill(0); }
}

function resolveVendorElectron(provider, fs, options) {
  if (options.vendorElectron) return options.vendorElectron;
  if ((options.platform || process.platform) !== 'darwin') return '';
  const home = resolveHostHomeDir({ env: options.env || process.env, hostHomeDir: options.hostHomeDir });
  const config = getProviderCLIConfig(provider);
  for (const template of config?.desktopClient?.macos?.installPaths || []) {
    const executable = path.join(template.replace('{hostHomeDir}', home), 'Contents', 'MacOS', 'Electron');
    try { if (fs.statSync(executable).isFile()) return executable; } catch (_) {}
  }
  return '';
}

function runVendorCodec(value, provider, operation, options) {
  if (!['workbuddy', 'workbuddycn'].includes(provider)) throw new Error('unsupported_encrypted_credential');
  const command = resolveVendorElectron(provider, options.fs || require('node:fs'), options);
  if (!command) throw new Error('encrypted_credential_runtime_missing');
  const input = JSON.stringify({ value, operation });
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error('encrypted_credential_too_large');
  const run = options.execFileSync || execFileSync;
  const output = run(command, [path.join(__dirname, '../../scripts/aih-workbuddy-credential-codec.cjs')], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_BYTES,
    env: { ...(options.env || process.env), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore']
  });
  return JSON.parse(output);
}

function decodeWorkbuddyCredential(value, provider, options = {}) {
  if (!hasWorkbuddyEncryptedCredentials(value)) return { credential: value, encrypted: false };
  const run = options.execFileSync || execFileSync;
  const fingerprint = `${provider}:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  const cached = cachedCredentials.get(fingerprint);
  if (cached?.run === run) return { credential: cached.credential, encrypted: true };
  const credential = runVendorCodec(value, provider, 'decode', options);
  cachedCredentials.set(fingerprint, { credential, run });
  if (cachedCredentials.size > 32) cachedCredentials.delete(cachedCredentials.keys().next().value);
  return { credential, encrypted: true };
}

function encodeWorkbuddyCredential(value, provider, options = {}) {
  return runVendorCodec(value, provider, 'encode', options);
}

module.exports = { decodeWorkbuddyCredential, encodeWorkbuddyCredential,
  hasWorkbuddyEncryptedCredentials, transformWorkbuddyCredentials };
