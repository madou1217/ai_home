'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

// ZCode 原生运行时在 ~/.zcode/v2/credentials.json 中保存共享凭据，值使用
// AES-256-GCM 加密（`enc:v1:<nonce>.<tag>.<ciphertext>`，key = sha256(secret)）。
// 密钥优先取 ZCODE_CREDENTIAL_SECRET，否则由 platform:homedir:username 派生。
const ZCODE_CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';
const ZCODE_CREDENTIAL_ENVELOPE_PREFIX = 'enc:v1:';

const ZCODE_CREDENTIAL_KEYS = Object.freeze({
  ACTIVE_PROVIDER: 'oauth:active_provider',
  ZAI_ACCESS_TOKEN: 'oauth:zai:access_token',
  ZAI_REFRESH_TOKEN: 'oauth:zai:refresh_token',
  ZAI_USER_INFO: 'oauth:zai:user_info',
  ZCODE_JWT_TOKEN: 'zcodejwttoken'
});

// config.json 里可携带 API key 的内置 Anthropic provider id。
const ZCODE_API_PROVIDER_IDS = Object.freeze(['builtin:zai', 'builtin:bigmodel']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveZcodeCredentialSecret(env = process.env, osImpl = os) {
  const fromEnv = normalizeString(env[ZCODE_CREDENTIAL_SECRET_ENV]);
  if (fromEnv) return fromEnv;
  let username = 'unknown';
  try {
    username = osImpl.userInfo().username;
  } catch {
    // os.userInfo 在少数环境抛错，zcode 本体同样回退为 unknown。
  }
  return `zcode-credential-fallback:${osImpl.platform()}:${osImpl.homedir()}:${username}`;
}

function isEncryptedZcodeCredentialValue(value) {
  return typeof value === 'string' && value.startsWith(ZCODE_CREDENTIAL_ENVELOPE_PREFIX);
}

function decryptZcodeCredentialValue(value, { env = process.env, osImpl = os, cryptoImpl = crypto } = {}) {
  if (!isEncryptedZcodeCredentialValue(value)) return value;
  const parts = value.slice(ZCODE_CREDENTIAL_ENVELOPE_PREFIX.length).split('.');
  if (parts.length < 3) return '';
  try {
    const key = cryptoImpl.createHash('sha256').update(resolveZcodeCredentialSecret(env, osImpl)).digest();
    const decipher = cryptoImpl.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts.slice(2).join('.'), 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    // 密钥不匹配或密文损坏（跨机器导入未携带 secret 时会出现）。
    return '';
  }
}

function encryptZcodeCredentialValue(value, { env = process.env, osImpl = os, cryptoImpl = crypto } = {}) {
  const nonce = cryptoImpl.randomBytes(12);
  const key = cryptoImpl.createHash('sha256').update(resolveZcodeCredentialSecret(env, osImpl)).digest();
  const cipher = cryptoImpl.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [
    ZCODE_CREDENTIAL_ENVELOPE_PREFIX,
    nonce.toString('base64url'),
    '.',
    cipher.getAuthTag().toString('base64url'),
    '.',
    ciphertext.toString('base64url')
  ].join('');
}

function decryptZcodeCredentialRecord(record, options = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const out = {};
  for (const key of Object.keys(source)) {
    out[key] = isEncryptedZcodeCredentialValue(source[key])
      ? decryptZcodeCredentialValue(source[key], options)
      : source[key];
  }
  return out;
}

function parseJwtPayload(token, { cryptoImpl = crypto } = {}) {
  const parts = normalizeString(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 解析 zcode 共享凭据（nativeAuth.credentials = credentials.json 原文）。
 * OAuth 计划账号没有 refresh token；jwtToken 过期只能重新 login 导入。
 */
function readZcodeOAuthCredential(nativeAuth = {}, options = {}) {
  const credentials = nativeAuth.credentials && typeof nativeAuth.credentials === 'object'
    ? nativeAuth.credentials
    : {};
  const plain = decryptZcodeCredentialRecord(credentials, options);
  const accessToken = normalizeString(plain[ZCODE_CREDENTIAL_KEYS.ZAI_ACCESS_TOKEN]);
  const jwtToken = normalizeString(plain[ZCODE_CREDENTIAL_KEYS.ZCODE_JWT_TOKEN]);
  let userInfo = {};
  try {
    const parsed = JSON.parse(plain[ZCODE_CREDENTIAL_KEYS.ZAI_USER_INFO]);
    if (parsed && typeof parsed === 'object') userInfo = parsed;
  } catch {
    // user_info 缺失或损坏时仍可用 token 哈希作身份种子。
  }
  const activeProvider = normalizeString(plain[ZCODE_CREDENTIAL_KEYS.ACTIVE_PROVIDER]);
  return {
    accessToken,
    jwtToken,
    refreshToken: normalizeString(plain[ZCODE_CREDENTIAL_KEYS.ZAI_REFRESH_TOKEN]),
    userInfo,
    activeProvider,
    configured: Boolean(accessToken || jwtToken)
  };
}

/**
 * 解析 zcode config.json 的 API-key provider 配置。
 * 返回 { providerId, apiKey, baseURL } 或 null。
 */
function readZcodeApiProviderConfig(nativeAuth = {}) {
  const config = nativeAuth.config && typeof nativeAuth.config === 'object'
    ? nativeAuth.config
    : {};
  const providerRegistry = config.provider && typeof config.provider === 'object'
    ? config.provider
    : {};
  for (const providerId of ZCODE_API_PROVIDER_IDS) {
    const entry = providerRegistry[providerId];
    if (!entry || typeof entry !== 'object') continue;
    const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
    const apiKey = normalizeString(options.apiKey);
    if (!apiKey) continue;
    return {
      providerId,
      apiKey,
      baseURL: normalizeString(options.baseURL || options.baseUrl)
    };
  }
  return null;
}

function hashZcodeSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

module.exports = {
  ZCODE_API_PROVIDER_IDS,
  ZCODE_CREDENTIAL_KEYS,
  ZCODE_CREDENTIAL_SECRET_ENV,
  decryptZcodeCredentialRecord,
  decryptZcodeCredentialValue,
  encryptZcodeCredentialValue,
  hashZcodeSecret,
  isEncryptedZcodeCredentialValue,
  parseJwtPayload,
  readZcodeApiProviderConfig,
  readZcodeOAuthCredential,
  resolveZcodeCredentialSecret
};
