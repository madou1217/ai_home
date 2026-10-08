'use strict';

const { isAccountRef } = require('../account/public-account-ref');
const { inspectCodebuddyCredential } = require('../account/codebuddy-credential-source');
const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { getDatabaseSyncCtor, getSqliteTableColumns } = require('../sessions/session-reader-utils');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../sessions/session-reader-codebuddy');
const { stableHash } = require('./model-usage-stable-hash');
const { createNativeMessageOwnership } = require('./codebuddy-native-message-ownership');

const FAMILY = new Set(CODEBUDDY_FAMILY_PROVIDERS);

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
    matches.push(account.accountRef);
    identities.set(key, matches);
  }
  const fingerprint = stableHash(JSON.stringify([...identities.entries()]));
  const writer = createNativeMessageOwnership({ ...options, accounts });

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
    const matches = identities.get(`${file.provider}:${userId}`) || [];
    return { provider: file.provider, accountRef: matches.length === 1 ? matches[0] : '', userId };
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

module.exports = { createCodebuddyUsageOwnership, sameRegion };
