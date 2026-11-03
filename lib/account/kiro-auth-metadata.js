'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { parseIdentityObject } = require('./identity-subject');

// kiro CLI 的 auth_kv 里**三个凭据槽**，对应三种登录身份：
//   * `kirocli:odic:token`        —— AWS Builder ID / IAM Identity Center（SSO OIDC）
//   * `kirocli:social:token`      —— Google / GitHub（social）
//   * `kirocli:external-idp:token`—— 企业外部 IdP
//
// **为什么必须都读**（2026-10-17 实测）：同一个邮箱的 Builder ID 与 Google social 是
// **两个不同的上游身份**，订阅绑在购买时用的那个身份上。只读 odic 槽会把「本机用 Google
// 登录、权益是 PRO+」的账号读成 Builder ID（FREE）—— 这正是「web 上 pro+、aih 显示 free」
// 的根因。官方 CLI 自己也是三槽全查（binary: "not logged in with Builder ID / Social /
// External IdP"）。
//
// 槽位顺序 = 优先级：官方 CLI 的登录态是**单账号**模型（后登录的覆盖先登录的），
// 三槽同时存在时无法从数据判断哪个「当前生效」，因此按官方 CLI 的检查顺序取第一个可用槽，
// 并把**命中的槽名**一并带出来（下游据此走对应的刷新口径）。
const KIRO_TOKEN_SLOTS = Object.freeze([
  'kirocli:odic:token',
  'kirocli:social:token',
  'kirocli:external-idp:token'
]);

/** 槽名 → 刷新/身份口径。social 与 external-idp 都走 desktop 口径（无 device-registration）。 */
const KIRO_SLOT_FLAVOURS = Object.freeze({
  'kirocli:odic:token': 'odic',
  'kirocli:social:token': 'social',
  'kirocli:external-idp:token': 'external-idp'
});

// aih 私有的元数据行（非机密）：authMethod、IDE 导入的去重指纹等。
//
// **为什么不塞进 CLI 的 token 行**：CLI 槽位的行格式归 kiro-cli 所有（Rust serde 结构），
// 往里加字段属于赌它容忍未知字段。单独一个键，CLI 按键查询、看不到它；aih 读 token 时合并回来。
const KIRO_AUTH_META_KEY = 'aih:kiro:auth-meta';
const KIRO_AUTH_META_FIELDS = Object.freeze(['authMethod', 'authSourceFingerprint']);

// social 槽的 provider 取值：CLI 自己写的是小写（实测 `google`），读取时也认 Google/GitHub 写法。
const KIRO_SOCIAL_PROVIDER_VALUES = Object.freeze({ google: 'google', github: 'github' });

/** 归一 social 登录提供方；认不出返回 ''（调用方据此退回旧行为，不猜）。 */
function normalizeKiroSocialProvider(value) {
  return KIRO_SOCIAL_PROVIDER_VALUES[String(value || '').trim().toLowerCase()] || '';
}

/**
 * aih 的 auth 行 → kiro-cli `kirocli:social:token` 槽的原生形状。
 *
 * 字段取自官方二进制的 `struct SocialToken`，并由 2026-10-18 实测确认：用这个形状写入的库，
 * 真 kiro-cli（`KIRO_TEST_DB_PATH`）能直接用它列出模型。缺 profile_arn 时 CLI 会判 token 无效
 * （"social token has no profile ARN, treating as invalid"），因此原样带上。
 */
function buildKiroSocialSlotRow(auth, provider) {
  return {
    access_token: String(auth.access_token || auth.accessToken || ''),
    expires_at: String(auth.expires_at || auth.expiresAt || ''),
    refresh_token: String(auth.refresh_token || auth.refreshToken || ''),
    provider,
    profile_arn: String(auth.profileArn || auth.profile_arn || '')
  };
}

/** 从 auth 行挑出 aih 私有元数据（没有任何字段时返回 null，不写空行）。 */
function pickKiroAuthMeta(auth) {
  const meta = {};
  for (const field of KIRO_AUTH_META_FIELDS) {
    const value = String(auth && auth[field] || '').trim();
    if (value) meta[field] = value;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function normalizeKiroSlotToken(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const accessToken = String(parsed.access_token || parsed.accessToken || '').trim();
  const refreshToken = String(parsed.refresh_token || parsed.refreshToken || '').trim();
  if (!accessToken && !refreshToken) return null;
  return parsed;
}

/**
 * 读 kiro 的凭据行 —— **三槽全查**，返回命中的槽名。
 *
 * aih 私有元数据行存在时合并进返回的 token（只补缺，不覆盖 CLI 字段）。
 *
 * @returns {{token: object, slot: string}|null} 三槽都空时返回 null
 */
function readKiroTokenRecord(databasePath, options = {}) {
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  if (!DatabaseSync || !databasePath) return null;
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const statement = database.prepare('SELECT value FROM auth_kv WHERE key = ?');
    for (const slot of KIRO_TOKEN_SLOTS) {
      const row = statement.get(slot);
      const parsed = normalizeKiroSlotToken(row && parseIdentityObject(String(row.value || '')));
      if (!parsed) continue;
      const metaRow = statement.get(KIRO_AUTH_META_KEY);
      const meta = metaRow && parseIdentityObject(String(metaRow.value || ''));
      return { token: meta && typeof meta === 'object' ? { ...meta, ...parsed } : parsed, slot };
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    try { database?.close(); } catch (_error) {}
  }
}

/**
 * 读 kiro 的 token 行（保持既有签名：调用方只要 token 本身）。
 *
 * 三槽全查：social / external-idp 账号以前读不到（只查 odic 槽），现在能读到了。
 */
function readKiroTokenFromDatabase(databasePath, options = {}) {
  const record = readKiroTokenRecord(databasePath, options);
  return record ? record.token : null;
}

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

// A native Kiro login can commit its token to the WAL while the CLI remains
// alive. Copying data.sqlite3 alone would then save an older credential. VACUUM
// INTO asks SQLite for a consistent snapshot and includes committed WAL pages;
// the temporary file never becomes an AIH credential source.
function readKiroDatabaseSnapshot(databasePath, options = {}) {
  const DatabaseSync = options.DatabaseSync || loadDatabaseSync();
  const fs = options.fs || nodeFs;
  const os = options.os || nodeOs;
  const path = options.path || nodePath;
  if (!DatabaseSync || !databasePath) return null;
  let database = null;
  let tempDir = '';
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-snapshot-'));
    const target = path.join(tempDir, 'data.sqlite3');
    database.prepare('VACUUM INTO ?').run(target);
    const bytes = fs.readFileSync(target);
    if (!bytes || bytes.length === 0) return null;
    // 快照同时带回**命中的槽名**：下游据此把 flavor 显式落库，
    // 否则 social 账号会在下次刷新时被猜成 odic（误判）。
    const record = readKiroTokenRecord(target, options);
    return {
      database: Buffer.from(bytes).toString('base64'),
      auth: record ? record.token : null,
      authSlot: record ? record.slot : ''
    };
  } catch (_error) {
    return null;
  } finally {
    try { database?.close(); } catch (_error) {}
    if (tempDir) {
      try {
        if (typeof fs.rmSync === 'function') fs.rmSync(tempDir, { recursive: true, force: true });
        else fs.rmdirSync(tempDir, { recursive: true });
      } catch (_error) {}
    }
  }
}

module.exports = {
  KIRO_AUTH_META_KEY,
  KIRO_SLOT_FLAVOURS,
  KIRO_TOKEN_SLOTS,
  buildKiroSocialSlotRow,
  normalizeKiroSocialProvider,
  pickKiroAuthMeta,
  readKiroDatabaseSnapshot,
  readKiroTokenFromDatabase,
  readKiroTokenRecord
};
