'use strict';

const path = require('node:path');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const { readClaudeKeychainCredentialRecord } = require('./claude-keychain');
const { readClaudeOauthCredential } = require('./claude-credential');
const {
  readClaudeHostIdentity,
  readClaudeHostCredentialFileRecord,
  resolveCredentialIdentity,
  mergeClaudeCredentialIdentity
} = require('./claude-host-credentials');
const {
  deriveAccountRuntimeStatus,
  replacePersistedAccountRuntimeState
} = require('../server/account-runtime-state');

// 普通 Claude 会话内的 /login 不退出进程，也不经过 AIH 的专用登录收尾。
// 在调度前吸收同身份的新登录凭据；此服务只读宿主，绝不把选中账号投射回共享 Keychain。
function createClaudeLoginRecovery(deps = {}) {
  const { fs, aiHomeDir, hostHomeDir, accountStateIndex, accountStateService } = deps;
  const processObj = deps.processObj || process;
  const readKeychain = deps.readClaudeKeychainCredentialRecord || readClaudeKeychainCredentialRecord;

  return function recoverClaudeLogin(account) {
    if (!account || account.provider !== 'claude' || account.apiKeyMode
      || account.authType !== 'oauth' || !fs || !aiHomeDir || !hostHomeDir
      || !accountStateIndex || !accountStateService) {
      return { recovered: false, reason: 'not_applicable' };
    }
    const row = accountStateIndex.getAccountState(account.accountRef);
    if (!row || row.status !== 'up') return { recovered: false, reason: 'not_active' };
    const runtime = row && row.runtimeState;
    if (!runtime || deriveAccountRuntimeStatus(runtime).status !== 'auth_invalid') {
      return { recovered: false, reason: 'not_auth_invalid' };
    }
    const record = readAccountCredentialRecord(fs, aiHomeDir, account.accountRef);
    if (!record || record.provider !== 'claude') return { recovered: false, reason: 'unknown_account' };

    const hostIdentities = readClaudeHostIdentity(fs, hostHomeDir);
    const candidates = [];
    const file = readClaudeHostCredentialFileRecord(fs, hostHomeDir);
    if (file) candidates.push({ ...file, source: 'host_file' });
    if (processObj.platform === 'darwin') {
      const options = {
        processObj, configDir: path.join(hostHomeDir, '.claude'), includeDefaultService: false,
        execFileSync: deps.execFileSync
      };
      const keychain = readKeychain(options);
      if (keychain) candidates.push({ ...keychain, source: 'keychain' });
      // 旧 AIH 会删除 USER，Bun 版 Claude 把 /login 写到 unknown 用户条目。
      // 仅在恢复流程读取该确切条目，仍须通过身份、失败时间和新凭据校验。
      const legacy = readKeychain({ ...options, account: 'unknown' });
      if (legacy) candidates.push({ ...legacy, source: 'legacy_keychain' });
    }
    candidates.sort((left, right) => Number(right.modifiedAtMs) - Number(left.modifiedAtMs));
    const current = readClaudeOauthCredential(record.nativeAuth);
    for (const candidate of candidates) {
      const changedAt = Number(candidate.modifiedAtMs) || 0;
      if (changedAt <= Number(runtime.lastFailureAt || 0)) continue;
      if (!resolveCredentialIdentity(record, candidate, hostIdentities).ok) continue;
      const next = readClaudeOauthCredential({ credentials: candidate.credentials });
      if (!next.accessToken || !next.refreshToken || next.expiresAt <= Date.now()) continue;
      const changed = next.accessToken !== current.accessToken;
      if (changedAt <= Number(record.nativeAuthUpdatedAt) && changed) continue;
      // 相同旧 token 不能靠重写文件时间解除阻断；已采纳但清状态失败的重试例外。
      if (!changed && Number(record.nativeAuthUpdatedAt) <= Number(runtime.lastFailureAt || 0)) continue;
      if (changed) {
        writeAccountNativeAuth(fs, aiHomeDir, account.accountRef, {
          ...record.nativeAuth,
          credentials: mergeClaudeCredentialIdentity(record.nativeAuth.credentials, candidate.credentials)
        });
      }
      const cleared = accountStateService.clearRuntimeBlock(account.accountRef, 'claude', {
        evidence: 'credential_update_after_failure'
      });
      if (!cleared) return { recovered: false, reason: 'runtime_clear_rejected' };
      Object.assign(account, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        tokenExpiresAt: next.expiresAt,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt || null
      });
      replacePersistedAccountRuntimeState(account, accountStateIndex.getAccountState(account.accountRef).runtimeState);
      return { recovered: true, source: candidate.source };
    }
    return { recovered: false, reason: 'no_verified_new_login' };
  };
}

module.exports = { createClaudeLoginRecovery };
