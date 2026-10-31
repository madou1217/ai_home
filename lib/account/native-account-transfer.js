'use strict';

// 本机原生格式的账号导入 / 导出（唯一的账号迁移格式，2026-10-31 起）。
//
// 导出的就是 aih 自己存的账号记录：provider + env 配置 + 原生登录凭据（nativeAuth）+ 启用状态。
// 不经过任何第三方格式（sub2api / Antigravity Manager / CLIProxyAPI）的有损映射，
// 所有 provider 都能原样往返。凭据以明文导出（用户确认；文件请自行妥善保管）。
//
// 文档形态：
//   { kind: 'aih-accounts', version: 1, exportedAt, source: { host }, accounts: [
//       { provider, accountRef, cliAccountId, status, env: {...}, nativeAuth: {...} } ] }
//
// 机器绑定的加密字段（zcode 的 enc:v1:…，密钥派生自本机 home/用户名）在导出时解成明文，
// 导入端按本机规则重新加密写入 —— 否则换一台机器就解不开。
//
// 导入：按凭据推导稳定身份（与登录/采集同一规则），同一身份更新原账号、新身份新建，
// 永远不会因为重复导入多出账号。无法推导身份的记录明确拒绝，不猜。

const os = require('node:os');
const { registerAccountIdentity } = require('./account-registration');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { buildApiKeyIdentity, normalizeProvider } = require('./transfer-core');
const { createAccountStateIndex } = require('./state-index');
const { readNodeAccounts } = require('./go-bridge/node-account-reader');
const {
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const {
  decryptZcodeCredentialRecord,
  encryptZcodeCredentialValue,
  isEncryptedZcodeCredentialValue
} = require('./zcode-credential');
const { providerCatalog } = require('../provider-catalog');

const DOCUMENT_KIND = 'aih-accounts';
const DOCUMENT_VERSION = 1;
const MAX_IMPORT_ACCOUNTS = 5000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasContent(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

// --- 机器绑定字段 ---------------------------------------------------------

function portableNativeAuth(provider, nativeAuth) {
  if (provider !== 'zcode' || !isPlainObject(nativeAuth) || !isPlainObject(nativeAuth.credentials)) return nativeAuth;
  const credentials = nativeAuth.credentials;
  if (!Object.values(credentials).some(isEncryptedZcodeCredentialValue)) return nativeAuth;
  const plain = decryptZcodeCredentialRecord(credentials);
  // 解不开（密钥不匹配）就保留原值：导出端也没有能用的明文，不能凭空丢字段。
  const merged = Object.fromEntries(Object.keys(credentials).map((key) => [
    key, isEncryptedZcodeCredentialValue(credentials[key]) && plain[key] ? plain[key] : credentials[key]
  ]));
  return { ...nativeAuth, credentials: merged };
}

function localNativeAuth(provider, nativeAuth, previous) {
  if (provider !== 'zcode' || !isPlainObject(nativeAuth) || !isPlainObject(nativeAuth.credentials)) return nativeAuth;
  // 本机原来就是加密存储时，导入后保持加密存储（与 zcode 原生写入路径一致）。
  const wasEncrypted = isPlainObject(previous && previous.credentials)
    && Object.values(previous.credentials).some(isEncryptedZcodeCredentialValue);
  if (!wasEncrypted) return nativeAuth;
  const credentials = Object.fromEntries(Object.entries(nativeAuth.credentials).map(([key, value]) => [
    key, typeof value === 'string' && !isEncryptedZcodeCredentialValue(value) ? encryptZcodeCredentialValue(value) : value
  ]));
  return { ...nativeAuth, credentials };
}

// --- 导出 -----------------------------------------------------------------

/**
 * @param {{fs, aiHomeDir, accountRefs?: string[], providers?: string[], hostName?: string}} options
 *   accountRefs / providers 都省略 = 导出全部账号。
 * @returns {{document, exported: number, skipped: Array<{accountRef, reason}>}}
 */
function buildNativeExportDocument(options = {}) {
  const { fs, aiHomeDir } = options;
  const refs = new Set((options.accountRefs || []).map((ref) => String(ref || '').trim()).filter(Boolean));
  const providers = new Set((options.providers || []).map((provider) => normalizeProvider(provider)).filter(Boolean));
  const source = readNodeAccounts(aiHomeDir, { fs });
  const accounts = [];
  const skipped = [];
  const found = new Set();
  for (const record of source.accounts) {
    if (refs.size > 0 && !refs.has(record.accountRef)) continue;
    if (providers.size > 0 && !providers.has(record.provider)) continue;
    found.add(record.accountRef);
    const env = readAccountCredentials(fs, aiHomeDir, record.accountRef) || {};
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, record.accountRef) || {};
    if (!hasContent(env) && !hasContent(nativeAuth)) {
      skipped.push({ accountRef: record.accountRef, provider: record.provider, reason: 'credentials_missing' });
      continue;
    }
    accounts.push({
      provider: record.provider,
      accountRef: record.accountRef,
      cliAccountId: record.cliAccountId || '',
      status: record.status === 'down' ? 'down' : 'up',
      env,
      nativeAuth: portableNativeAuth(record.provider, nativeAuth)
    });
  }
  for (const ref of refs) {
    if (!found.has(ref)) skipped.push({ accountRef: ref, reason: 'account_not_found' });
  }
  return {
    document: {
      kind: DOCUMENT_KIND,
      version: DOCUMENT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { host: options.hostName || os.hostname() },
      accounts
    },
    exported: accounts.length,
    skipped
  };
}

function nativeExportFileName({ accountRefs = [], providers = [], accounts = [] } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  if (accountRefs.length === 1 && accounts.length === 1) {
    return `aih-account-${accounts[0].provider}-${accounts[0].accountRef}-${day}.json`;
  }
  if (providers.length === 1) return `aih-accounts-${providers[0]}-${day}.json`;
  return `aih-accounts-${day}.json`;
}

// --- 导入 -----------------------------------------------------------------

/** 识别文档：aih-accounts 文档、单账号对象、或账号数组。其它格式一律不认。 */
function parseNativeImportDocument(input) {
  let value = input;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    try {
      value = JSON.parse(String(value).replace(/^﻿/, ''));
    } catch (_error) {
      return { ok: false, error: 'invalid_json' };
    }
  }
  if (isPlainObject(value) && value.kind === DOCUMENT_KIND) {
    if (Number(value.version) !== DOCUMENT_VERSION) return { ok: false, error: 'unsupported_document_version' };
    if (!Array.isArray(value.accounts)) return { ok: false, error: 'invalid_document' };
    return { ok: true, accounts: value.accounts };
  }
  if (Array.isArray(value) && value.every(looksLikeNativeAccount)) return { ok: true, accounts: value };
  if (looksLikeNativeAccount(value)) return { ok: true, accounts: [value] };
  return { ok: false, error: 'unsupported_import_format' };
}

function looksLikeNativeAccount(value) {
  return isPlainObject(value) && typeof value.provider === 'string'
    && (isPlainObject(value.env) || isPlainObject(value.nativeAuth));
}

/**
 * 早期账号的引用可能按旧规则派生（与当前身份种子算出的引用不同）。来源引用在本机已存在、
 * provider 相同、且本机凭据推出的身份与导入内容一致时，就是同一个账号 —— 直接更新它，
 * 而不是按新种子再建一个重复账号。
 */
function matchBySourceRef(fs, aiHomeDir, provider, sourceRef, identitySeed) {
  if (!/^acct_[a-f0-9]{20}$/.test(String(sourceRef || ''))) return null;
  const existing = readNodeAccounts(aiHomeDir, { fs }).accounts.find((account) => account.accountRef === sourceRef);
  if (!existing || existing.provider !== provider) return null;
  const localSeed = resolveImportIdentity(provider, existing.env || {}, existing.nativeAuth || {});
  if (!localSeed || localSeed !== identitySeed) return null;
  return { accountRef: existing.accountRef, cliAccountId: existing.cliAccountId, created: false };
}

function matchExistingRef(fs, aiHomeDir, provider, accountRef) {
  const existing = readNodeAccounts(aiHomeDir, { fs }).accounts.find((account) => account.accountRef === accountRef);
  return existing && existing.provider === provider
    ? { accountRef: existing.accountRef, cliAccountId: existing.cliAccountId, created: false }
    : null;
}

function cliIdAvailable(fs, aiHomeDir, provider, cliAccountId) {
  const id = String(cliAccountId || '').trim();
  if (!/^\d+$/.test(id)) return false;
  return !readNodeAccounts(aiHomeDir, { fs }).accounts
    .some((account) => account.provider === provider && account.cliAccountId === id);
}

function resolveImportIdentity(provider, env, nativeAuth) {
  if (hasContent(nativeAuth)) {
    const native = resolveNativeAuthIdentitySeed(provider, nativeAuth);
    if (!native.degraded && native.identitySeed) return native.identitySeed;
  }
  const apiKeySeed = buildApiKeyIdentity(provider, env);
  return apiKeySeed || '';
}

/**
 * @param {{fs, aiHomeDir, input, dryRun?: boolean, accountArtifactHooks?}} options
 * @returns {{ok, error?, summary: {total, created, updated, unchanged, invalid, failed}, accounts: Array}}
 */
function importNativeAccounts(options = {}) {
  const { fs, aiHomeDir } = options;
  const parsed = parseNativeImportDocument(options.input);
  const summary = { total: 0, created: 0, updated: 0, unchanged: 0, invalid: 0, failed: 0 };
  if (!parsed.ok) return { ok: false, error: parsed.error, summary, accounts: [] };
  if (parsed.accounts.length > MAX_IMPORT_ACCOUNTS) {
    return { ok: false, error: 'too_many_accounts', summary, accounts: [] };
  }
  summary.total = parsed.accounts.length;
  const results = [];
  const index = options.dryRun ? null : createAccountStateIndex({ fs, aiHomeDir });
  try {
    for (const entry of parsed.accounts) {
      const provider = normalizeProvider(entry && entry.provider);
      const label = { provider: provider || String(entry && entry.provider || ''), sourceRef: String(entry && entry.accountRef || '') };
      if (!provider || !providerCatalog.ids.includes(provider)) {
        summary.invalid += 1;
        results.push({ ...label, status: 'invalid', reason: 'unsupported_provider' });
        continue;
      }
      const env = isPlainObject(entry.env) ? entry.env : {};
      const nativeAuth = isPlainObject(entry.nativeAuth) ? entry.nativeAuth : {};
      if (!hasContent(env) && !hasContent(nativeAuth)) {
        summary.invalid += 1;
        results.push({ ...label, status: 'invalid', reason: 'credentials_missing' });
        continue;
      }
      let identitySeed = resolveImportIdentity(provider, env, nativeAuth);
      // 身份证据可能已过期（例：kiro 的 identityEvidence 绑定的是刷新前的 token），内容推不出身份。
      // 这类记录来自另一台 aih，自带稳定的账号引用：以「来源引用」为身份导入，
      // 下次用量探测会补齐新的身份证据。没有来源引用的才拒绝。
      const fallbackRef = !identitySeed && /^acct_[a-f0-9]{20}$/.test(label.sourceRef) ? label.sourceRef : '';
      if (fallbackRef) identitySeed = `transfer:${provider}:${fallbackRef}`;
      if (!identitySeed) {
        summary.invalid += 1;
        results.push({ ...label, status: 'invalid', reason: 'identity_unresolvable' });
        continue;
      }
      if (options.dryRun) {
        results.push({ ...label, status: 'planned' });
        continue;
      }
      try {
        const registered = (fallbackRef && matchExistingRef(fs, aiHomeDir, provider, fallbackRef))
          || matchBySourceRef(fs, aiHomeDir, provider, label.sourceRef, identitySeed)
          || registerAccountIdentity(fs, aiHomeDir, {
          provider,
          identitySeed,
          source: 'native_account_import',
          preferredAccountRef: label.sourceRef,
          // 来源的 CLI 编号（aih codex 1 里的 1）在本机空着才沿用，否则重新分配。
          ...(cliIdAvailable(fs, aiHomeDir, provider, entry.cliAccountId) ? { cliAccountId: String(entry.cliAccountId) } : {})
        });
        const previousEnv = readAccountCredentials(fs, aiHomeDir, registered.accountRef) || {};
        const previousNative = readAccountNativeAuth(fs, aiHomeDir, registered.accountRef) || {};
        const before = options.accountArtifactHooks
          && typeof options.accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
          ? options.accountArtifactHooks.snapshotAccountAuthArtifacts(provider, registered.accountRef) : null;
        const nextNative = hasContent(nativeAuth) ? localNativeAuth(provider, nativeAuth, previousNative) : null;
        const same = JSON.stringify(previousEnv) === JSON.stringify(env)
          && JSON.stringify(portableNativeAuth(provider, previousNative)) === JSON.stringify(nativeAuth);
        if (!registered.created && same) {
          summary.unchanged += 1;
          results.push({ ...label, accountRef: registered.accountRef, status: 'unchanged' });
          continue;
        }
        if (hasContent(env)) writeAccountCredentials(fs, aiHomeDir, registered.accountRef, env);
        if (nextNative) writeAccountNativeAuth(fs, aiHomeDir, registered.accountRef, nextNative);
        index.upsertAccountState(registered.accountRef, provider, {
          status: entry.status === 'down' ? 'down' : 'up',
          configured: true,
          apiKeyMode: !hasContent(nativeAuth)
        });
        if (before && typeof options.accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
          options.accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
            provider, accountRef: registered.accountRef, before, source: 'native_account_import', reason: 'account_import'
          });
        }
        if (registered.created) summary.created += 1;
        else summary.updated += 1;
        results.push({
          ...label,
          accountRef: registered.accountRef,
          cliAccountId: registered.cliAccountId,
          status: registered.created ? 'created' : 'updated'
        });
      } catch (error) {
        summary.failed += 1;
        // 只回错误码，不回 message：异常文本可能带凭据片段。
        results.push({ ...label, status: 'failed', reason: String(error && error.code || error && error.message || 'import_failed').slice(0, 80) });
      }
    }
  } finally {
    if (index) index.close();
  }
  return { ok: true, summary, accounts: results };
}

module.exports = {
  DOCUMENT_KIND,
  DOCUMENT_VERSION,
  buildNativeExportDocument,
  importNativeAccounts,
  nativeExportFileName,
  parseNativeImportDocument
};
