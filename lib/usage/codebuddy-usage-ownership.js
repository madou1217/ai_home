'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const { inspectCodebuddyCredential } = require('../account/codebuddy-credential-source');
const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { getDatabaseSyncCtor, getSqliteTableColumns } = require('../sessions/session-reader-utils');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../sessions/session-reader-codebuddy');
const { stableHash } = require('./model-usage-stable-hash');
const { createNativeMessageOwnership } = require('./codebuddy-native-message-ownership');
const { listEntries: listPersistentSessions } = require('../runtime/persistent-session-registry');

const FAMILY = new Set(CODEBUDDY_FAMILY_PROVIDERS);

// 终端会话的账号真值：run/persistent-sessions/*.json 里有 nativeSessionId + accountRef。
// CLI 的 configDir 切到 ~/.codebuddy 后，账号投影里的私有日志不再更新，这份注册表是
// 原生会话最可靠的归属证据（同一会话被多个账号续写时保持空归属，不猜）。
function readRegistrySessionOwners(aiHomeDir, fs) {
  const owners = new Map();
  if (!aiHomeDir) return owners;
  let entries = [];
  try { entries = listPersistentSessions(aiHomeDir, { fs }); } catch (_) { return owners; }
  for (const entry of entries) {
    const sessionId = String(entry && entry.nativeSessionId || '').trim();
    const provider = String(entry && entry.provider || '').trim();
    const accountRef = String(entry && entry.accountRef || '').trim();
    if (!sessionId || !FAMILY.has(provider) || !isAccountRef(accountRef)) continue;
    const matches = owners.get(sessionId) || new Set();
    matches.add(`${provider}:${accountRef}`);
    owners.set(sessionId, matches);
  }
  return owners;
}

function sameRegion(left, right) {
  return FAMILY.has(left) && FAMILY.has(right) && left.endsWith('cn') === right.endsWith('cn');
}

function readNativeUsers(root, { fs, path, DatabaseSync }) {
  const users = new Map();
  const file = path.join(path.dirname(root), 'workbuddy.db');
  const Constructor = DatabaseSync || getDatabaseSyncCtor();
  if (!Constructor || !fs.existsSync(file)) return users;
  let db;
  try {
    db = new Constructor(file, { readOnly: true });
    const columns = getSqliteTableColumns(db, 'sessions');
    if (!columns.has('id') || !columns.has('user_id')) return users;
    for (const row of db.prepare('SELECT id, user_id FROM sessions').all()) {
      users.set(String(row.id), String(row.user_id || '').trim());
    }
  } catch (_) { /* 原生索引不可读时保留未归属统计，不猜测账号。 */ }
  finally { try { if (db) db.close(); } catch (_) {} }
  return users;
}

function createCodebuddyUsageOwnership(options) {
  const accounts = new Map();
  const identities = new Map();
  const usersByRoot = new Map();
  const snapshot = options.accounts || readNodeAccounts(options.aiHomeDir, { fs: options.fs }).accounts;
  for (const account of snapshot) {
    if (!FAMILY.has(account.provider) || !isAccountRef(account.accountRef)) continue;
    accounts.set(account.accountRef, account.provider);
    const inspected = inspectCodebuddyCredential(account.nativeAuth && account.nativeAuth.credentials, account.provider);
    if (!inspected.ok) continue;
    const key = `${account.provider}:${inspected.uid}`;
    const matches = identities.get(key) || [];
    matches.push({ accountRef: account.accountRef, provider: account.provider });
    identities.set(key, matches);
  }
  const fingerprint = stableHash(JSON.stringify([...identities.entries()]));

  // userId 可能在同一自然人的多个站点/别名账号下都出现；跨 Provider 汇总后
  // 只有唯一账号才认，否则保持空归属，绝不猜。
  function resolveUserIdOwner(userId) {
    const text = String(userId || '').trim();
    if (!text) return null;
    const matches = [];
    for (const [key, owners] of identities) {
      if (key.slice(key.indexOf(':') + 1) !== text) continue;
      matches.push(...owners);
    }
    const unique = new Map(matches.map((owner) => [`${owner.provider}:${owner.accountRef}`, owner]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  const writer = createNativeMessageOwnership({
    ...options,
    accounts,
    // 共享日志（~/.codebuddy/logs）没有账号目录，按 pid 行里的 userId 反查。
    resolveLogOwner: ({ userId }) => resolveUserIdOwner(userId)
  });
  const registryOwners = readRegistrySessionOwners(options.aiHomeDir, options.fs);

  function normalizeScope(scope, provider) {
    if (!scope || !sameRegion(provider, scope.provider)
      || accounts.get(scope.accountRef) !== scope.provider
      || !(scope.startedAtMs > 0) || !(scope.completedAtMs >= scope.startedAtMs)) return null;
    return { provider: scope.provider, accountRef: scope.accountRef,
      startedAtMs: scope.startedAtMs, completedAtMs: scope.completedAtMs };
  }

  function resolveNative(file) {
    if (!usersByRoot.has(file.projectsRoot)) {
      usersByRoot.set(file.projectsRoot, readNativeUsers(file.projectsRoot, options));
    }
    const userId = usersByRoot.get(file.projectsRoot).get(file.sessionId) || '';
    // 会话级写入证据优先：同一会话只有一个账号写过时，它比 user_id 更可靠
    // （user_id 只能说明谁登录过，writer 证据说明谁写了这条消息）。
    const sessionOwner = typeof writer.sessionOwner === 'function' ? writer.sessionOwner(file) : null;
    if (sessionOwner) return { ...sessionOwner, userId };
    const registered = registryOwners.get(String(file.sessionId));
    if (registered && registered.size === 1) {
      const only = [...registered][0];
      const index = only.indexOf(':');
      return { provider: only.slice(0, index), accountRef: only.slice(index + 1), userId };
    }
    if (!userId) return { provider: file.provider, accountRef: '', userId };
    const only = resolveUserIdOwner(userId);
    if (only) return { provider: only.provider, accountRef: only.accountRef, userId };
    return { provider: file.provider, accountRef: '', userId };
  }

  function resolve(file, timestampMs, scope, previous, messageId) {
    if (scope && timestampMs >= scope.startedAtMs && timestampMs <= scope.completedAtMs) {
      return { provider: scope.provider, accountRef: scope.accountRef };
    }
    // 历史的明确归属不会因切换账号、删除账号或共享目录的入口变化而被覆盖。
    if (previous && sameRegion(file.provider, previous.provider) && isAccountRef(previous.account_ref)) {
      return { provider: previous.provider, accountRef: previous.account_ref };
    }
    return writer.resolve(file, messageId, timestampMs) || resolveNative(file);
  }

  return { fingerprint, writerFingerprint: writer.fingerprint, normalizeScope, resolve, resolveNative };
}

module.exports = { createCodebuddyUsageOwnership, readRegistrySessionOwners, sameRegion };
