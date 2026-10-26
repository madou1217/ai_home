'use strict';

// Go -> Node 的本机凭据适配器。只使用 provider 明确声明的可逆策略，
// 复用账号注册和凭据存储端口；先反向核对身份，再建立同步 link。
const { getGoAccountImportStrategy } = require('../../providers');
const { registerAccountIdentity } = require('../account-registration');
const { resolveNativeAuthIdentitySeed } = require('../account-identity');
const { writeAccountCredentials, writeAccountNativeAuth } = require('../../server/account-credential-store');
const { readNodeAccounts } = require('./node-account-reader');
const { translateNodeAccount } = require('./go-import-translator');
const { createAccountStateIndex } = require('../state-index');

function matchingPlan(record, account) {
  if (record.provider !== account.provider) return null;
  const plan = translateNodeAccount(record);
  return plan.kind === 'import' && plan.predictedGoRef === account.accountRef ? plan : null;
}

function adoptGoAccount(account, deps = {}) {
  const strategy = getGoAccountImportStrategy(account.provider, account.authKind, account.authMode);
  if (typeof strategy !== 'function') return { kind: 'unsupported' };
  try {
    const readNode = deps.readNodeAccounts || readNodeAccounts;
    const before = readNode(deps.aiHomeDir);
    for (const existing of before.accounts) {
      const plan = matchingPlan(existing, account);
      if (plan) return { kind: 'adopted', nodeRef: existing.accountRef, plan, created: false };
    }
    const translated = strategy(account);
    const record = {
      provider: account.provider, accountRef: account.accountRef,
      env: translated.env || {}, nativeAuth: translated.nativeAuth || {}
    };
    // 两端引用的派生规则不同（静态 key 尤其如此），写入前先反向核对身份。
    if (!matchingPlan(record, account)) return { kind: 'error', error: 'node_import_identity_mismatch' };
    const native = resolveNativeAuthIdentitySeed(record.provider, record.nativeAuth);
    const identitySeed = translated.identitySeed || (!native.degraded && native.identitySeed);
    const registered = registerAccountIdentity(deps.fs, deps.aiHomeDir, {
      provider: record.provider, identitySeed, respectDeletion: true
    });
    const occupied = before.accounts.find((entry) => entry.accountRef === registered.accountRef);
    // 历史引用可能已对应另一套端点配置，绝不因收养覆盖现有凭据。
    if (occupied && !matchingPlan(occupied, account)) return { kind: 'error', error: 'node_import_identity_conflict' };
    if (translated.env) writeAccountCredentials(deps.fs, deps.aiHomeDir, registered.accountRef, translated.env);
    if (translated.nativeAuth) writeAccountNativeAuth(deps.fs, deps.aiHomeDir, registered.accountRef, translated.nativeAuth);
    const index = createAccountStateIndex({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
    try {
      if (!index.upsertAccountState(registered.accountRef, record.provider, {
        status: account.enabled ? 'up' : 'down', configured: true, apiKeyMode: account.authKind !== 'oauth'
      })) return { kind: 'error', error: 'node_import_state_failed' };
    } finally {
      index.close();
    }
    const imported = readNode(deps.aiHomeDir).accounts.find((entry) => entry.accountRef === registered.accountRef);
    const plan = imported && matchingPlan(imported, account);
    return plan
      ? { kind: 'adopted', nodeRef: registered.accountRef, plan, created: registered.created }
      : { kind: 'error', error: 'node_import_identity_mismatch' };
  } catch (_error) {
    if (_error && _error.code === 'account_deleted_by_user') return { kind: 'unsupported' };
    // 凭据转换/导入错误可能含原始内容，只返回固定错误码。
    return { kind: 'error', error: 'node_import_failed' };
  }
}

module.exports = { adoptGoAccount };
