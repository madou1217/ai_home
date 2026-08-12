'use strict';

const nodePath = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  readClaudeKeychainCredentialRecord,
  writeClaudeKeychainCredentials
} = require('./claude-keychain');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { writeAccountNativeAuth } = require('../server/account-credential-store');

// Claude Code 将 OAuth 账号身份放在 ~/.claude/.claude.json，而不是放在
// macOS Keychain 的 token envelope 中。这里的身份集合用于防止共享 Keychain
// 被另一个 Claude 账号的凭据污染。
function normalizeIdentityPart(value) {
  return String(value || '').trim().toLowerCase();
}

function addClaudeIdentity(set, kind, value) {
  const normalized = normalizeIdentityPart(value);
  if (!normalized) return;
  set.add(kind === 'uuid'
    ? `oauth:claude:uuid:${normalized}`
    : `oauth:claude:${normalized}`);
}

function readClaudeOAuth(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return {};
  const oauth = credentials.claudeAiOauth || credentials.claude_ai_oauth;
  return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : {};
}

function hasUsableClaudeOAuth(credentials) {
  const oauth = readClaudeOAuth(credentials);
  const accessToken = String(oauth.accessToken || oauth.access_token || '').trim();
  const refreshToken = String(oauth.refreshToken || oauth.refresh_token || '').trim();
  return Boolean(accessToken && refreshToken);
}

function resolveClaudeIdentitySet(credentials) {
  const oauth = readClaudeOAuth(credentials);
  const account = oauth.account && typeof oauth.account === 'object' && !Array.isArray(oauth.account)
    ? oauth.account
    : {};
  const identities = new Set();
  addClaudeIdentity(identities, 'uuid', account.uuid || account.accountUuid || account.account_uuid);
  addClaudeIdentity(
    identities,
    'email',
    oauth.email || oauth.emailAddress || oauth.email_address
      || account.email || account.emailAddress || account.email_address
  );
  // 兼容历史导入 envelope 的嵌套字段，但只有在直接字段没有身份时才
  // 使用既有身份解析器，避免改变 UUID 优先级和邮箱规范化规则。
  if (identities.size === 0) {
    const resolved = resolveNativeAuthIdentitySeed('claude', { credentials });
    if (resolved && resolved.degraded === false && resolved.identitySeed) {
      identities.add(String(resolved.identitySeed));
    }
  }
  return identities;
}

function resolveClaudeIdentity(credentials) {
  const identities = resolveClaudeIdentitySet(credentials);
  // UUID 比邮箱稳定，优先用于同一账号的凭据轮换判断。
  return [...identities].find((identity) => identity.startsWith('oauth:claude:uuid:'))
    || [...identities][0]
    || '';
}

// 官方凭据文件。macOS 上 Keychain 不一定有对应条目（宿主没登录过、或登录走的是
// 不带 CLAUDE_CONFIG_DIR 的裸 service），此时 ~/.claude/.credentials.json 才是宿主
// 登录态的真相。只读到「能用」的信封才算数：空 token 的残留信封等于没有。
function readClaudeHostCredentialFileRecord(fs, hostHomeDir, pathImpl = nodePath) {
  const root = String(hostHomeDir || '').trim();
  if (!fs || typeof fs.readFileSync !== 'function' || !root) return null;
  const filePath = pathImpl.join(root, '.claude', '.credentials.json');
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
  if (!hasUsableClaudeOAuth(credentials)) return null;

  let modifiedAtMs = 0;
  try {
    modifiedAtMs = Number(fs.statSync(filePath).mtimeMs) || 0;
  } catch (_error) {
    modifiedAtMs = 0;
  }
  return { credentials, modifiedAtMs };
}

function readClaudeHostIdentity(fs, hostHomeDir, pathImpl = nodePath) {
  const root = String(hostHomeDir || '').trim();
  if (!fs || typeof fs.readFileSync !== 'function' || !root) return new Set();
  const filePath = pathImpl.join(root, '.claude', '.claude.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return new Set();
  }
  const oauthAccount = parsed && parsed.oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
    return new Set();
  }
  const identities = new Set();
  addClaudeIdentity(identities, 'uuid', oauthAccount.accountUuid || oauthAccount.account_uuid);
  addClaudeIdentity(identities, 'email', oauthAccount.emailAddress || oauthAccount.email_address || oauthAccount.email);
  return identities;
}

function hasIdentityIntersection(left, right) {
  if (!left || !right || left.size === 0 || right.size === 0) return false;
  for (const identity of left) {
    if (right.has(identity)) return true;
  }
  return false;
}

function hasIdentityKind(set, prefix) {
  return [...(set || [])].filter((identity) => identity.startsWith(prefix));
}

function hasConflictingUuid(left, right) {
  const leftUuids = hasIdentityKind(left, 'oauth:claude:uuid:');
  const rightUuids = hasIdentityKind(right, 'oauth:claude:uuid:');
  if (leftUuids.length === 0 || rightUuids.length === 0) return false;
  return !leftUuids.some((identity) => right.has(identity));
}

function resolveCredentialIdentity(record, keychainRecord, hostIdentities) {
  const databaseIdentities = resolveClaudeIdentitySet(record && record.nativeAuth && record.nativeAuth.credentials);
  const keychainIdentities = resolveClaudeIdentitySet(keychainRecord && keychainRecord.credentials);
  const hasHostIdentity = hostIdentities && hostIdentities.size > 0;

  if (hasHostIdentity && hasConflictingUuid(databaseIdentities, hostIdentities)) {
    return { ok: false, reason: 'host_identity_mismatch' };
  }
  if (hasHostIdentity && !hasIdentityIntersection(databaseIdentities, hostIdentities)) {
    return { ok: false, reason: 'host_identity_mismatch' };
  }
  if (keychainIdentities.size > 0 && hasConflictingUuid(databaseIdentities, keychainIdentities)) {
    return { ok: false, reason: 'keychain_identity_mismatch' };
  }
  if (keychainIdentities.size > 0 && !hasIdentityIntersection(databaseIdentities, keychainIdentities)) {
    return { ok: false, reason: 'keychain_identity_mismatch' };
  }
  if (keychainIdentities.size > 0 && hasHostIdentity
    && (hasConflictingUuid(keychainIdentities, hostIdentities)
      || !hasIdentityIntersection(keychainIdentities, hostIdentities))) {
    return { ok: false, reason: 'host_keychain_identity_mismatch' };
  }

  // Keychain token envelope 没有身份时，只有官方全局身份文件与目标账号一致，
  // 才能把它视为同一个账号；否则禁止将数据库旧 token 写回共享 Keychain。
  if (keychainRecord && keychainIdentities.size === 0) {
    if (!hasHostIdentity || !hasIdentityIntersection(databaseIdentities, hostIdentities)) {
      return { ok: false, reason: 'keychain_identity_unverified' };
    }
  }
  return {
    ok: true,
    databaseIdentities,
    keychainIdentities,
    hostIdentities: hostIdentities || new Set()
  };
}

function buildDatabaseResult(credentials, reason, keychainUpdated = false) {
  return {
    ok: true,
    credentials,
    source: 'database',
    reason,
    keychainUpdated,
    databaseUpdated: false
  };
}

function mergeClaudeCredentialIdentity(databaseCredentials, keychainCredentials) {
  const databaseOauth = readClaudeOAuth(databaseCredentials);
  const keychainOauth = readClaudeOAuth(keychainCredentials);
  const oauthKey = keychainCredentials && keychainCredentials.claude_ai_oauth
    ? 'claude_ai_oauth'
    : 'claudeAiOauth';
  const mergedOauth = { ...keychainOauth };
  const databaseAccount = databaseOauth.account;
  if (databaseAccount && typeof databaseAccount === 'object' && !Array.isArray(databaseAccount)) {
    mergedOauth.account = { ...databaseAccount, ...(mergedOauth.account || {}) };
  }
  for (const field of ['email', 'emailAddress', 'email_address']) {
    if (!mergedOauth[field] && databaseOauth[field]) mergedOauth[field] = databaseOauth[field];
  }
  return {
    ...(keychainCredentials && typeof keychainCredentials === 'object' ? keychainCredentials : {}),
    [oauthKey]: mergedOauth
  };
}

function shouldAdoptKeychainCredentials(record, keychainRecord, hostIdentities) {
  if (!hasUsableClaudeOAuth(keychainRecord.credentials)) return false;
  const databaseIdentities = resolveClaudeIdentitySet(record.nativeAuth.credentials);
  const keychainIdentities = resolveClaudeIdentitySet(keychainRecord.credentials);
  const sameIdentity = keychainIdentities.size > 0
    ? hasIdentityIntersection(databaseIdentities, keychainIdentities)
    : hasIdentityIntersection(databaseIdentities, hostIdentities);
  return sameIdentity && Number(keychainRecord.modifiedAtMs) > Number(record.nativeAuthUpdatedAt);
}

function createClaudeHostCredentialReconciler(deps = {}) {
  const processObj = deps.processObj || process;
  // host-sync 显式注入 fs。直接调用 reconciler 时不猜测宿主文件，避免
  // 测试或其他运行时意外读取当前用户的 ~/.claude 身份。
  const fs = deps.fs;
  const path = deps.path || nodePath;
  const readKeychain = deps.readClaudeKeychainCredentialRecord || readClaudeKeychainCredentialRecord;
  const writeKeychain = deps.writeClaudeKeychainCredentials || writeClaudeKeychainCredentials;
  const writeNativeAuth = deps.writeAccountNativeAuth || writeAccountNativeAuth;

  // 正常 AIH Claude 进程显式使用 host ~/.claude 作为 CLAUDE_CONFIG_DIR。
  // Claude Code 会从这个绝对路径派生带 hash 的 Keychain service；读写裸
  // `Claude Code-credentials` 会让同步结果与实际 CLI 寻址分裂。
  function projectDatabaseCredentials(record, credentials, reason) {
    const configDir = path.join(String(deps.hostHomeDir || '').trim(), '.claude');
    const result = writeKeychain(credentials, {
      processObj,
      configDir,
      includeDefaultService: false,
      execFileSync: deps.execFileSync
    });
    if (!result || !result.ok) {
      return { ok: false, reason: 'keychain_write_failed' };
    }
    return buildDatabaseResult(credentials, reason, true);
  }

  /**
   * 宿主自己刷新/重新登录时，新的 token 只落在 ~/.claude/.credentials.json（以及不带
   * CLAUDE_CONFIG_DIR 的裸 keychain 槽），我们读的哈希槽和数据库都还停在旧快照。
   * 此时若按旧逻辑「数据库是选中账号，直接投射」，就会把宿主刚拿到的登录态覆盖成
   * 过期 token——用户下一次用非 aih 的 claude 就是 `Login expired · Please run /login`。
   * 所以同身份且文件更新时，以宿主为准回灌数据库。
   */
  function adoptHostFileCredentials(record, fileRecord, keychainRecord) {
    if (!fileRecord) return null;
    const fileAtMs = Number(fileRecord.modifiedAtMs) || 0;
    // 时间戳读不到就不能证明宿主更新，宁可不动。
    if (fileAtMs <= 0) return null;
    if (fileAtMs <= Number(record.nativeAuthUpdatedAt)) return null;
    if (keychainRecord && fileAtMs <= Number(keychainRecord.modifiedAtMs)) return null;
    if (isDeepStrictEqual(fileRecord.credentials, record.nativeAuth.credentials)) return null;

    const databaseIdentities = resolveClaudeIdentitySet(record.nativeAuth.credentials);
    const fileIdentities = resolveClaudeIdentitySet(fileRecord.credentials);
    // 宿主文件属于别的账号时不能回灌：那是账号切换，不是同一账号的 token 轮换。
    if (!hasIdentityIntersection(databaseIdentities, fileIdentities)) return null;

    const mergedCredentials = mergeClaudeCredentialIdentity(
      record.nativeAuth.credentials,
      fileRecord.credentials
    );
    writeNativeAuth(deps.fs, deps.aiHomeDir, record.accountRef, {
      ...record.nativeAuth,
      credentials: mergedCredentials
    });
    // 哈希槽同步跟上，否则下一轮又会拿旧的 keychain 去和新数据库比较。
    const projected = writeKeychain(mergedCredentials, {
      processObj,
      configDir: path.join(String(deps.hostHomeDir || '').trim(), '.claude'),
      includeDefaultService: false,
      execFileSync: deps.execFileSync
    });
    return {
      ok: true,
      credentials: mergedCredentials,
      source: 'host_file',
      reason: 'host_file_newer',
      keychainUpdated: Boolean(projected && projected.ok),
      databaseUpdated: true
    };
  }

  function adoptKeychainCredentials(record, credentials) {
    const mergedCredentials = mergeClaudeCredentialIdentity(
      record.nativeAuth.credentials,
      credentials
    );
    writeNativeAuth(deps.fs, deps.aiHomeDir, record.accountRef, {
      ...record.nativeAuth,
      credentials: mergedCredentials
    });
    return {
      ok: true,
      credentials: mergedCredentials,
      source: 'keychain',
      reason: 'keychain_newer',
      keychainUpdated: false,
      databaseUpdated: true
    };
  }

  return function reconcileClaudeHostCredentials(record) {
    const credentials = record && record.nativeAuth && record.nativeAuth.credentials;
    if (!hasUsableClaudeOAuth(credentials)) {
      return { ok: false, reason: 'incomplete_claude_oauth' };
    }
    if (processObj.platform !== 'darwin') {
      return buildDatabaseResult(credentials, 'keychain_not_applicable');
    }

    // 与 claude-strategy.js 的正常启动环境保持同一寻址：共享会话目录
    // 仍是 host ~/.claude，凭据只落在该目录派生的 Keychain 槽位。
    const configDir = path.join(String(deps.hostHomeDir || '').trim(), '.claude');
    const hostIdentities = typeof deps.readClaudeHostIdentity === 'function'
      ? deps.readClaudeHostIdentity()
      : readClaudeHostIdentity(fs, deps.hostHomeDir, path);
    const keychainRecord = readKeychain({
      processObj,
      configDir,
      includeDefaultService: false,
      execFileSync: deps.execFileSync
    });

    // 先看宿主凭据文件：它比 keychain 哈希槽更早拿到「宿主自己刷新/重新登录」的结果，
    // 必须在任何「以数据库为准投射」之前判断，否则新登录态会被旧快照覆盖掉。
    const hostFileRecord = typeof deps.readClaudeHostCredentialFileRecord === 'function'
      ? deps.readClaudeHostCredentialFileRecord()
      : readClaudeHostCredentialFileRecord(fs, deps.hostHomeDir, path);
    const adoptedFromHostFile = adoptHostFileCredentials(record, hostFileRecord, keychainRecord);
    if (adoptedFromHostFile) return adoptedFromHostFile;

    if (!keychainRecord || !keychainRecord.credentials) {
      // host ~/.claude 可能仍显示上一个 CLI 账号；数据库记录是本次明确
      // 选择的账号。只要数据库自身带稳定 UUID/邮箱，就可以安全写入该
      // host 配置对应的 hashed service，不应把切换误报成身份冲突。
      if (!resolveClaudeIdentity(credentials)) {
        return { ok: false, reason: 'database_identity_unverified' };
      }
      return projectDatabaseCredentials(record, credentials, 'keychain_missing');
    }

    const identity = resolveCredentialIdentity(record, keychainRecord, hostIdentities);
    // 选中账号必须有可验证的数据库身份；没有身份时禁止把未知 envelope
    // 写入共享 Keychain。存在身份冲突只表示宿主仍是另一个账号，下面会
    // 以数据库选中账号为准完成切换。
    if (!resolveClaudeIdentity(credentials)) {
      return { ok: false, reason: 'database_identity_unverified' };
    }
    if (!hasUsableClaudeOAuth(keychainRecord.credentials)) {
      // 数据库账号已经通过稳定 UUID/邮箱校验；Keychain 中残留的残缺
      // envelope 无论属于哪个账号，都不能阻止明确选中的账号覆盖它。
      // 同账号场景保留更具体的诊断原因，跨账号场景标记为切换。
      return projectDatabaseCredentials(
        record,
        credentials,
        identity.ok ? 'keychain_credentials_incomplete' : 'database_selected_account'
      );
    }
    if (isDeepStrictEqual(keychainRecord.credentials, credentials)) {
      return buildDatabaseResult(credentials, 'keychain_current');
    }
    if (shouldAdoptKeychainCredentials(record, keychainRecord, hostIdentities)) {
      return adoptKeychainCredentials(record, keychainRecord.credentials);
    }
    // modifiedAt 缺失时无法证明数据库快照更新，宁可保留可用的 Keychain
    // 凭据，也不把可能过期的数据库 refresh token 覆盖回官方存储。
    if (Number(keychainRecord.modifiedAtMs) <= 0) {
      if (!identity.ok) {
        return projectDatabaseCredentials(record, credentials, 'database_selected_account');
      }
      return {
        ok: true,
        credentials: keychainRecord.credentials,
        source: 'keychain',
        reason: 'keychain_timestamp_unknown',
        keychainUpdated: false,
        databaseUpdated: false
      };
    }
    // 数据库快照是本次明确选择的账号。宿主 .claude.json 或当前 Keychain
    // 可能仍属于上一个账号，不能因此阻止账号切换。
    return projectDatabaseCredentials(record, credentials, 'database_selected_account');
  };
}

module.exports = {
  createClaudeHostCredentialReconciler,
  hasUsableClaudeOAuth,
  resolveClaudeIdentity,
  resolveClaudeIdentitySet,
  readClaudeHostIdentity
};
