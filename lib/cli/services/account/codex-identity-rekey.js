'use strict';

// Codex OAuth 身份 rekey：§8.1 要求的显式映射账本。
//
// 身份向量从 `oauth:codex:<email>` 换成 `oauth:codex:<user_id>`
// （见 docs/architecture/codex-oauth-identity-vector-adr.md）。既有账号仍带着按邮箱派生的
// accountRef，必须重写——而 §8.1 禁止静默改写：它要求显式映射账本
// `old_account_ref -> account_ref + resolution`，冲突逐条裁决，并禁止双写、回读 fallback
// 和影子账号表。
//
// 本模块分两半：
//   - planCodexIdentityRekey：只读。给每个 codex 账号定性并产出账本，不写任何东西。
//   - applyCodexIdentityRekey：消费**已复核**的账本，重写已落库的 accountRef。
//
// 重写「按构造完整」：它枚举 SQLite schema，重写**每一个名为 `account_ref` 的列**，
// 而不是靠一份手工维护的表清单——后者在新增表时会静默留下过期引用。

const {
  buildCodexOAuthIdentitySeed
} = require('../../../account/codex-auth-metadata');
const {
  extractOAuthEmail,
  normalizeProvider
} = require('../../../account/transfer-core');
const { getPublicAccountRef } = require('../../../account/public-account-ref');
const {
  listCliAccountRefRecords
} = require('../../../server/account-ref-store');
const {
  readAccountNativeAuth
} = require('../../../server/account-credential-store');
const {
  listTableColumns,
  openAppStateDatabase
} = require('../../../server/app-state-store');

// 账本里每个账号的定性。
const RESOLUTION = Object.freeze({
  // 已经在 user_id 向量上，不需要动。
  ALREADY_CURRENT: 'already_current',
  // 在邮箱向量上，且新 ref 没被占用：可以迁移。
  MIGRATE: 'migrate',
  // 新 ref 已经被另一个旧账号占用：**必须人工裁决**，不自动合并。
  CONFLICT: 'conflict',
  // 在邮箱向量上，但凭据拿不到稳定 user_id：无法迁移，只能先补登录态。
  UNVERIFIABLE: 'unverifiable',
  // 既不在邮箱向量也不在 user_id 向量上：不是本次迁移的对象，如实报告。
  UNRECOGNIZED: 'unrecognized'
});

// 会被重写的列名。`account_ref` 覆盖绝大多数表；`execution_account_ref` 是
// chat-runtime 的派生存列，同一次重写必须一起走，否则运行态会指向已消失的账号。
const ACCOUNT_REF_COLUMNS = Object.freeze(['account_ref', 'execution_account_ref']);

const LEDGER_SCHEMA_VERSION = 1;

// normalizeEmail 与 extractOAuthEmail 同口径，用于复算旧的邮箱向量。
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// resolveCodexAuthJson 取到 codex 的 auth.json（可能被包在 `{ auth: … }` 里）。
function resolveCodexAuthJson(nativeAuth) {
  const source = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth : {};
  return source.auth && typeof source.auth === 'object' ? source.auth : source;
}

// planCodexIdentityRekey 为每个 codex 账号定性并产出账本（只读）。
//
// 定性不靠猜凭据形状，而是**直接复算两条向量**：拿凭据里的邮箱复算旧 ref、拿稳定
// user_id 复算新 ref，再与落库的 accountRef 比。这样「这个账号到底在哪条向量上」是算出来的，
// 不是推断出来的——凭据形状以后怎么变都不会让定性悄悄失真。
function planCodexIdentityRekey(deps) {
  const { fs, aiHomeDir } = deps;
  const records = listCliAccountRefRecords(fs, aiHomeDir, 'codex', { bestEffort: false });
  const claimedByNewRef = new Map();
  const entries = [];

  for (const record of records) {
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, record.accountRef);
    const auth = resolveCodexAuthJson(nativeAuth);
    const email = normalizeEmail(extractOAuthEmail('codex', nativeAuth));
    const oldAccountRef = email
      ? getPublicAccountRef(`unique:oauth:codex:${email}`)
      : '';
    const identitySeed = buildCodexOAuthIdentitySeed(auth);
    const newAccountRef = identitySeed
      ? getPublicAccountRef(`unique:${identitySeed}`)
      : '';

    const entry = {
      old_account_ref: record.accountRef,
      new_account_ref: '',
      resolution: '',
      cli_account_id: record.cliAccountId,
      identity_seed: identitySeed,
      // 邮箱只用于人工裁决冲突（§8.1：「规范化邮箱只用于导入关联与冲突提示」）。
      // 它不参与身份派生。
      email,
      note: ''
    };

    if (newAccountRef && newAccountRef === record.accountRef) {
      entry.resolution = RESOLUTION.ALREADY_CURRENT;
      entry.new_account_ref = record.accountRef;
      entries.push(entry);
      continue;
    }
    if (!oldAccountRef || record.accountRef !== oldAccountRef) {
      // 既不是邮箱向量也不是 user_id 向量：如实报告，不猜、不动。
      entry.resolution = RESOLUTION.UNRECOGNIZED;
      entry.note = 'accountRef 不属于任何已知的 codex OAuth 向量';
      entries.push(entry);
      continue;
    }
    if (!newAccountRef) {
      entry.resolution = RESOLUTION.UNVERIFIABLE;
      entry.note = '凭据缺少稳定 user_id，无法派生新身份；需先补齐登录态';
      entries.push(entry);
      continue;
    }

    entry.new_account_ref = newAccountRef;
    const claimedBy = claimedByNewRef.get(newAccountRef);
    if (claimedBy && claimedBy !== record.accountRef) {
      // 同一 user_id 对应多条旧记录：邮箱向量把它们拆成了两个账号，user_id 向量会把它们
      // 合成一个。这个方向不可逆，**必须人工裁决**，绝不自动合并。
      entry.resolution = RESOLUTION.CONFLICT;
      entry.note = `新身份已被 ${claimedBy} 占用；同一 user_id 的多条旧记录需要人工裁决`;
      entries.push(entry);
      continue;
    }
    claimedByNewRef.set(newAccountRef, record.accountRef);
    entry.resolution = RESOLUTION.MIGRATE;
    entries.push(entry);
  }

  const summary = {
    total: entries.length,
    already_current: 0,
    migrate: 0,
    conflict: 0,
    unverifiable: 0,
    unrecognized: 0
  };
  for (const entry of entries) summary[entry.resolution] += 1;

  return {
    ledger: {
      schema_version: LEDGER_SCHEMA_VERSION,
      identity_scheme_version: 1,
      provider: normalizeProvider('codex'),
      from_vector: 'oauth:codex:<email>',
      to_vector: 'oauth:codex:<user_id>',
      generated_at: new Date(Number(deps.now) || Date.now()).toISOString(),
      summary,
      entries
    },
    summary
  };
}

// ledgerIsApplicable 判断账本是否可以执行。
//
// 两条硬门槛：没有未裁决的冲突，且没有无法迁移的账号。有任意一条就不允许 apply——
// 部分迁移会把账号体系留在「一部分旧 ref、一部分新 ref」的分裂状态，比不迁移更糟。
function ledgerIsApplicable(ledger) {
  const summary = ledger && ledger.summary ? ledger.summary : {};
  const conflicts = Number(summary.conflict) || 0;
  const unverifiable = Number(summary.unverifiable) || 0;
  const unrecognized = Number(summary.unrecognized) || 0;
  const blockers = [];
  if (conflicts > 0) blockers.push(`${conflicts} 个冲突未裁决`);
  if (unverifiable > 0) blockers.push(`${unverifiable} 个账号缺稳定 user_id`);
  if (unrecognized > 0) blockers.push(`${unrecognized} 个账号的 accountRef 不属于已知向量`);
  return { applicable: blockers.length === 0, blockers };
}

// listAccountRefColumns 枚举库里所有需要重写的 (表, 列)。
//
// 这是「按构造完整」的关键：不维护表清单，而是问 schema 要。新增一张带 account_ref 的表
// 时，它自动进入重写范围，不会静默留下指向旧账号的引用。
function listAccountRefColumns(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const targets = [];
  for (const table of tables) {
    const name = String(table && table.name || '').trim();
    if (!name) continue;
    for (const column of listTableColumns(db, name)) {
      if (ACCOUNT_REF_COLUMNS.includes(column)) targets.push({ table: name, column });
    }
  }
  return targets;
}

// applyCodexIdentityRekey 按已复核的账本重写已落库的 accountRef。
//
// 单个事务：任何一步失败都整体回滚，不会留下部分迁移。
function applyCodexIdentityRekey(deps) {
  const { fs, aiHomeDir, ledger } = deps;
  if (!ledger || !Array.isArray(ledger.entries)) {
    return { applied: false, reason: 'ledger_invalid', rewritten: 0 };
  }
  const applicability = ledgerIsApplicable(ledger);
  if (!applicability.applicable) {
    return {
      applied: false,
      reason: 'ledger_has_blockers',
      blockers: applicability.blockers,
      rewritten: 0
    };
  }
  const migrations = ledger.entries.filter(
    (entry) => entry.resolution === RESOLUTION.MIGRATE
      && entry.old_account_ref
      && entry.new_account_ref
      && entry.old_account_ref !== entry.new_account_ref
  );
  if (migrations.length === 0) {
    return { applied: true, reason: 'nothing_to_do', rewritten: 0 };
  }

  const db = openAppStateDatabase(fs, aiHomeDir, { createIfMissing: false });
  if (!db) return { applied: false, reason: 'app_state_db_missing', rewritten: 0 };
  let inTransaction = false;
  try {
    const targets = listAccountRefColumns(db);
    // account_cli_aliases.account_ref 是指向 account_refs 的外键，且没有 ON UPDATE
    // CASCADE，所以直接 UPDATE 父键会立刻违反外键约束。
    //
    // 不能把 `PRAGMA foreign_keys = OFF` 放在事务里——SQLite 明确规定它在有未提交事务时
    // 是 no-op。必须在 BEGIN 之前关掉。这样做是安全的：父子在同一个事务里被改成彼此一致的
    // 新值，提交后关系仍然成立，因此下面提交前再跑一次 foreign_key_check 兜底。
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    let rewritten = 0;
    for (const entry of migrations) {
      for (const target of targets) {
        const statement = db.prepare(
          `UPDATE ${target.table} SET ${target.column} = ? WHERE ${target.column} = ?`
        );
        const result = statement.run(entry.new_account_ref, entry.old_account_ref);
        rewritten += Number(result && result.changes) || 0;
      }
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all() || [];
    if (violations.length > 0) {
      db.exec('ROLLBACK');
      inTransaction = false;
      db.exec('PRAGMA foreign_keys = ON');
      return {
        applied: false,
        reason: 'foreign_key_violation',
        violations: violations.slice(0, 10),
        rewritten: 0
      };
    }
    db.exec('COMMIT');
    inTransaction = false;
    db.exec('PRAGMA foreign_keys = ON');
    return { applied: true, reason: 'applied', rewritten, targets };
  } catch (error) {
    if (inTransaction && db) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    }
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_restoreError) {}
    return {
      applied: false,
      reason: 'apply_failed',
      error: String(error && error.message || error),
      rewritten: 0
    };
  } finally {
    if (typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

module.exports = {
  ACCOUNT_REF_COLUMNS,
  LEDGER_SCHEMA_VERSION,
  RESOLUTION,
  applyCodexIdentityRekey,
  ledgerIsApplicable,
  listAccountRefColumns,
  planCodexIdentityRekey
};
