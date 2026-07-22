'use strict';

const crypto = require('node:crypto');

/**
 * Qoder CLI auth helpers (global + CN).
 *
 * Credential storage under `--config-dir`:
 *   - `<variant>-credentials.json`  AES-256-GCM encrypted JSON (`iv:tag:cipher` hex)
 *   - `.keychain-salt`              32-byte scrypt salt (binary; AIH stores base64)
 *
 * Variant prefixes mirror the native CLI:
 *   global → `qoder-cli`
 *   CN     → `qoder-cli-cn`
 */

const QODER_VARIANTS = Object.freeze({
  qoder: Object.freeze({
    provider: 'qoder',
    credentialPrefix: 'qoder-cli',
    binaryName: 'qodercli',
    installRegion: 'global'
  }),
  qodercn: Object.freeze({
    provider: 'qodercn',
    credentialPrefix: 'qoder-cli-cn',
    binaryName: 'qoderclicn',
    installRegion: 'cn'
  })
});

function getQoderVariant(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return QODER_VARIANTS[key] || null;
}

function isQoderProvider(provider) {
  return !!getQoderVariant(provider);
}

function decodeSalt(value) {
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  const text = String(value || '').trim();
  if (!text) return null;
  // Prefer base64 (projection format). Fall back to raw utf8 for host files.
  try {
    const fromB64 = Buffer.from(text, 'base64');
    if (fromB64.length >= 16) return fromB64;
  } catch (_error) { /* fall through */ }
  return Buffer.from(text, 'utf8');
}

function deriveQoderEncryptionKey(credentialPrefix, saltValue) {
  const salt = decodeSalt(saltValue);
  if (!salt) return null;
  const prefix = String(credentialPrefix || '').trim();
  if (!prefix) return null;
  return crypto.scryptSync(`${prefix}-credentials`, salt, 32);
}

function decryptQoderCredentials(encryptedText, saltValue, credentialPrefix) {
  const raw = String(encryptedText || '').trim();
  if (!raw) return null;
  // Already plain JSON (e.g. materialised for tests / PAT projection).
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const key = deriveQoderEncryptionKey(credentialPrefix, saltValue);
  if (!key) return null;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'hex')),
      decipher.final()
    ]).toString('utf8');
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function encryptQoderCredentials(payload, saltValue, credentialPrefix) {
  const key = deriveQoderEncryptionKey(credentialPrefix, saltValue);
  if (!key) return '';
  const body = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function extractQoderIdentityFields(authPayload) {
  const payload = authPayload && typeof authPayload === 'object' ? authPayload : {};
  const email = firstNonEmptyString(
    payload.email,
    payload.emailAddress,
    payload.email_address,
    payload.user_email,
    payload.userEmail
  ).toLowerCase();
  const uid = firstNonEmptyString(
    payload.uid,
    payload.user_id,
    payload.userId,
    payload.account_id,
    payload.accountId,
    payload.id
  );
  const token = firstNonEmptyString(
    payload.security_oauth_token,
    payload.access_token,
    payload.accessToken,
    payload.token,
    payload.personal_access_token
  );
  return { email, uid, token, loginMethod: firstNonEmptyString(payload.login_method, payload.loginMethod) };
}

function buildQoderIdentitySeed(provider, authPayload) {
  const variant = getQoderVariant(provider);
  if (!variant) return '';
  const fields = extractQoderIdentityFields(authPayload);
  if (fields.email && fields.email.includes('@')) {
    return `oauth:${variant.provider}:${fields.email}`;
  }
  if (fields.uid) {
    return `oauth:${variant.provider}:uid:${fields.uid}`;
  }
  if (fields.token) {
    const digest = crypto.createHash('sha256').update(fields.token).digest('hex').slice(0, 16);
    return `oauth:${variant.provider}:token:${digest}`;
  }
  return '';
}

function extractQoderLoginProjectionMetadata(provider, outputRaw) {
  if (!getQoderVariant(provider)) return {};
  const output = String(outputRaw || '');
  const match = output.match(/Login successful!\s+Welcome,\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  const email = String(match && match[1] || '').trim().toLowerCase();
  return email ? { userInfo: { email } } : {};
}

function resolveQoderNativeAuthPayload(provider, nativeAuth) {
  const variant = getQoderVariant(provider);
  if (!variant) return null;
  const source = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth : {};
  if (source.userInfo && typeof source.userInfo === 'object') return source.userInfo;
  const encrypted = source.credentials;
  const salt = source.keychainSalt;
  if (typeof encrypted === 'string' && encrypted.trim()) {
    return decryptQoderCredentials(encrypted, salt, variant.credentialPrefix);
  }
  return null;
}

function summarizeQoderAuth(provider, nativeAuth, options = {}) {
  const variant = getQoderVariant(provider);
  if (!variant) return { configured: false, accountName: 'Unknown' };
  const payload = resolveQoderNativeAuthPayload(provider, nativeAuth);
  if (!payload) {
    // PAT may live only in env projection.
    const envToken = String(options.envToken || '').trim();
    if (envToken) {
      const short = envToken.length > 12
        ? `PAT: ${envToken.slice(0, 5)}...${envToken.slice(-4)}`
        : 'PAT Configured';
      return { configured: true, accountName: short, authMode: 'pat' };
    }
    return { configured: false, accountName: 'Unknown' };
  }
  const fields = extractQoderIdentityFields(payload);
  let accountName = 'Qoder Account';
  if (fields.email) accountName = fields.email;
  else if (fields.uid) accountName = `Qoder ${fields.uid.slice(0, 8)}`;
  else if (fields.token) {
    accountName = fields.token.length > 12
      ? `Token: ${fields.token.slice(0, 5)}...${fields.token.slice(-4)}`
      : 'Token Configured';
  }
  return {
    configured: true,
    accountName,
    authMode: fields.loginMethod || 'oauth',
    email: fields.email || '',
    uid: fields.uid || ''
  };
}

module.exports = {
  QODER_VARIANTS,
  getQoderVariant,
  isQoderProvider,
  decryptQoderCredentials,
  encryptQoderCredentials,
  extractQoderIdentityFields,
  extractQoderLoginProjectionMetadata,
  buildQoderIdentitySeed,
  resolveQoderNativeAuthPayload,
  summarizeQoderAuth
};
