'use strict';

// 插件包的发布者签名。
//
// 签名只证明「这个包由某把私钥签发、内容没有被改过」，**不证明代码安全**：
// 插件仍是独立进程里的任意代码，权限与审计另见 permissions/audit。
//
// 签名覆盖 metadata 里的 formatVersion + manifest + 文件表（每个文件的 sha256），
// 因此包内任何字节变化都会让签名失效。信任根是本机 <aiHome>/plugins/trusted-keys.json
// （0600，由 `aih plugin trust` 写入）；没有信任根时已签名包 fail closed，
// 未签名包按「未签名」安装并进入 doctor 警告，不做静默放行。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PluginError, requireCondition } = require('../sdk/errors');

const SIGNATURE_SCHEMA_VERSION = 1;
const TRUST_STORE_FILE = 'trusted-keys.json';
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ALGORITHM = 'ed25519';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function signedPayload(metadata) {
  return canonicalJson({
    formatVersion: metadata.formatVersion,
    manifest: metadata.manifest,
    files: metadata.files
  });
}

function normalizePublicKey(value) {
  const input = String(value || '').trim();
  requireCondition(input, 'plugin_signature_key_invalid', '公钥不能为空');
  try {
    const key = crypto.createPublicKey(input);
    requireCondition(key.asymmetricKeyType === 'ed25519', 'plugin_signature_key_invalid', '只支持 Ed25519 公钥');
    return key.export({ type: 'spki', format: 'pem' });
  } catch (error) {
    if (error && error.code === 'plugin_signature_key_invalid') throw error;
    throw new PluginError('plugin_signature_key_invalid', '公钥不是合法的 Ed25519 PEM');
  }
}

function publicKeyId(publicKeyPem) {
  return crypto.createHash('sha256').update(String(publicKeyPem)).digest('hex').slice(0, 24);
}

function trustStorePath(aiHomeDir) {
  return path.join(String(aiHomeDir || ''), 'plugins', TRUST_STORE_FILE);
}

function readTrustedKeys(aiHomeDir) {
  const file = trustStorePath(aiHomeDir);
  if (!file || !fs.existsSync(file)) return new Map();
  let document = null;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) {
    throw new PluginError('plugin_trust_store_invalid', `信任根文件不是合法 JSON：${file}`);
  }
  const keys = document && document.keys && typeof document.keys === 'object' ? document.keys : {};
  const out = new Map();
  for (const [keyId, record] of Object.entries(keys)) {
    if (!KEY_ID_PATTERN.test(keyId) || !record || typeof record.publicKeyPem !== 'string') continue;
    try { out.set(keyId, normalizePublicKey(record.publicKeyPem)); } catch (_error) { /* 坏条目跳过，doctor 会显示缺失 */ }
  }
  return out;
}

function writeTrustedKeys(aiHomeDir, keys) {
  const file = trustStorePath(aiHomeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const document = {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    keys: Object.fromEntries([...keys.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([keyId, pem]) => [
      keyId,
      { publicKeyPem: pem, addedAt: new Date().toISOString() }
    ]))
  };
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function addTrustedKey(aiHomeDir, input = {}) {
  const publicKeyPem = normalizePublicKey(input.publicKey || input.publicKeyPem);
  const keyId = String(input.keyId || '').trim() || publicKeyId(publicKeyPem);
  requireCondition(KEY_ID_PATTERN.test(keyId), 'plugin_signature_key_id_invalid', 'keyId 只允许字母、数字、._:-');
  const keys = readTrustedKeys(aiHomeDir);
  keys.set(keyId, publicKeyPem);
  writeTrustedKeys(aiHomeDir, keys);
  return { keyId, file: trustStorePath(aiHomeDir), fingerprint: publicKeyId(publicKeyPem) };
}

function removeTrustedKey(aiHomeDir, keyId) {
  const id = String(keyId || '').trim();
  requireCondition(id, 'plugin_signature_key_id_invalid');
  const keys = readTrustedKeys(aiHomeDir);
  const removed = keys.delete(id);
  if (removed) writeTrustedKeys(aiHomeDir, keys);
  return { keyId: id, removed, file: trustStorePath(aiHomeDir) };
}

function listTrustedKeys(aiHomeDir) {
  return [...readTrustedKeys(aiHomeDir).entries()].map(([keyId, pem]) => ({
    keyId,
    fingerprint: publicKeyId(pem),
    algorithm: ALGORITHM
  }));
}

function loadSigningKey(value) {
  const input = String(value || '').trim();
  requireCondition(input, 'plugin_signing_key_invalid', '签名私钥不能为空');
  // 私钥可以是 PEM 内容，也可以是文件路径（CLI 传文件路径）。
  const pem = input.includes('BEGIN') ? input : (fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '');
  try {
    const key = crypto.createPrivateKey(pem);
    requireCondition(key.asymmetricKeyType === 'ed25519', 'plugin_signing_key_invalid', '只支持 Ed25519 私钥');
    return key;
  } catch (error) {
    if (error && error.code === 'plugin_signing_key_invalid') throw error;
    throw new PluginError('plugin_signing_key_invalid', '私钥不是合法的 Ed25519 PEM 或文件');
  }
}

function signMetadata(metadata, input = {}) {
  const privateKey = loadSigningKey(input.privateKey || input.signingKey || input.signingKeyFile);
  const keyId = String(input.keyId || '').trim() || publicKeyId(normalizePublicKey(crypto.createPublicKey(privateKey).export({
    type: 'spki', format: 'pem'
  })));
  requireCondition(KEY_ID_PATTERN.test(keyId), 'plugin_signature_key_id_invalid', 'keyId 只允许字母、数字、._:-');
  const payload = Buffer.from(signedPayload(metadata));
  const signature = crypto.sign(null, payload, privateKey).toString('base64');
  return {
    algorithm: ALGORITHM,
    keyId,
    value: signature,
    signedAt: String(input.signedAt || new Date().toISOString())
  };
}

/**
 * 验证 metadata 里的签名。
 *
 * @returns {{status:'unsigned'|'signed'|'untrusted'|'invalid', keyId?, signedAt?, detail?}}
 * 不抛错；调用方决定是否 fail closed（acceptArtifact 对 invalid/untrusted 一律拒绝）。
 */
function verifyMetadataSignature(metadata, options = {}) {
  const signature = metadata && metadata.signature;
  if (!signature) return { status: 'unsigned' };
  if (signature.algorithm !== ALGORITHM || typeof signature.value !== 'string' || !signature.keyId) {
    return { status: 'invalid', detail: '签名结构不合法' };
  }
  let trusted = options.trustedKeys;
  if (!trusted && options.aiHomeDir) {
    try { trusted = readTrustedKeys(options.aiHomeDir); } catch (error) { return { status: 'invalid', detail: error.message }; }
  }
  if (!(trusted instanceof Map)) trusted = new Map();
  const publicKeyPem = trusted.get(String(signature.keyId));
  if (!publicKeyPem) return { status: 'untrusted', keyId: String(signature.keyId), detail: '本机没有该签名公钥' };
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(signedPayload(metadata)), publicKeyPem, Buffer.from(signature.value, 'base64'));
  } catch (_error) { ok = false; }
  if (!ok) return { status: 'invalid', keyId: String(signature.keyId), detail: '签名与包内容不匹配' };
  return { status: 'signed', keyId: String(signature.keyId), signedAt: String(signature.signedAt || '') };
}

module.exports = {
  ALGORITHM,
  SIGNATURE_SCHEMA_VERSION,
  TRUST_STORE_FILE,
  addTrustedKey,
  canonicalJson,
  listTrustedKeys,
  normalizePublicKey,
  publicKeyId,
  readTrustedKeys,
  removeTrustedKey,
  signMetadata,
  signedPayload,
  trustStorePath,
  verifyMetadataSignature,
  writeTrustedKeys
};
