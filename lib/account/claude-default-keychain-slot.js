'use strict';

// 宿主 ~/.claude 的登录态在 macOS Keychain 里有两个槽：设了 CLAUDE_CONFIG_DIR 的
// 进程读带 hash 后缀的槽（aih 启动的 claude），没设的读裸槽 `Claude Code-credentials`
// ——VSCode/JetBrains 插件、终端里直接敲的 claude 都是后者。两个槽是同一份默认登录，
// 只维护一边就会分叉：refresh token 会轮换，谁先刷新，另一边手里的就作废，插件随即
// 要求重新登录。这里负责裸槽这一边：读出来供吸收，选定凭据后再投影回去。

const { isDeepStrictEqual } = require('node:util');
const {
  readClaudeKeychainCredentialRecord,
  writeClaudeKeychainCredentials
} = require('./claude-keychain');

// Claude Code 只认驼峰字段。aih 写入的下划线别名会被它原样保留，它清空 token 后
// 下划线里仍是旧值——不能据此判断「可用」，否则会把一个它读不了的信封当成好登录。
function hasClaudeCodeReadableTokens(credentials) {
  const oauth = credentials && credentials.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return false;
  return Boolean(String(oauth.accessToken || '').trim() && String(oauth.refreshToken || '').trim());
}

function slotOptions(deps) {
  return { processObj: deps.processObj, execFileSync: deps.execFileSync };
}

/**
 * @returns {null | { credentials: object, modifiedAtMs: number, readable: boolean }}
 */
function readClaudeDefaultSlot(deps = {}) {
  const readKeychain = deps.readKeychain || readClaudeKeychainCredentialRecord;
  const record = readKeychain(slotOptions(deps));
  if (!record || !record.credentials) return null;
  return {
    credentials: record.credentials,
    modifiedAtMs: Number(record.modifiedAtMs) || 0,
    readable: hasClaudeCodeReadableTokens(record.credentials)
  };
}

/**
 * 裸槽缺失、或是 Claude Code 读不了的残缺信封、或是同一账号的旧 token，都写入选定凭据。
 * 里面若是另一个能用的账号，那是用户在 aih 之外自己登录的，只有显式设为默认才覆盖。
 */
function planClaudeDefaultSlotProjection(slot, credentials, options = {}) {
  if (!slot) return { write: true, reason: 'default_slot_missing' };
  if (!slot.readable) return { write: true, reason: 'default_slot_unreadable' };
  if (isDeepStrictEqual(slot.credentials, credentials)) return { write: false, reason: 'default_slot_current' };
  if (typeof options.sameAccount === 'function' && options.sameAccount(slot.credentials)) {
    return { write: true, reason: 'default_slot_rotated' };
  }
  if (options.selectedExplicitly === true) return { write: true, reason: 'default_slot_selected_account' };
  return { write: false, reason: 'default_slot_other_login_preserved' };
}

function syncClaudeDefaultSlot(slot, credentials, deps = {}) {
  if (!hasClaudeCodeReadableTokens(credentials)) {
    return { defaultSlotUpdated: false, defaultSlotReason: 'default_slot_source_unreadable' };
  }
  const plan = planClaudeDefaultSlotProjection(slot, credentials, deps);
  if (!plan.write) return { defaultSlotUpdated: false, defaultSlotReason: plan.reason };
  const writeKeychain = deps.writeKeychain || writeClaudeKeychainCredentials;
  const result = writeKeychain(credentials, slotOptions(deps));
  return result && result.ok
    ? { defaultSlotUpdated: true, defaultSlotReason: plan.reason }
    : { defaultSlotUpdated: false, defaultSlotReason: 'default_slot_write_failed' };
}

module.exports = {
  hasClaudeCodeReadableTokens,
  planClaudeDefaultSlotProjection,
  readClaudeDefaultSlot,
  syncClaudeDefaultSlot
};
