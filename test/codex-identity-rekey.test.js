'use strict';

// Codex OAuth identity rekey: the explicit mapping ledger §8.1 requires.
//
// See docs/architecture/codex-oauth-identity-vector-adr.md and
// lib/cli/services/account/codex-identity-rekey.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RESOLUTION,
  applyCodexIdentityRekey,
  ledgerIsApplicable,
  listAccountRefColumns,
  planCodexIdentityRekey
} = require('../lib/cli/services/account/codex-identity-rekey');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { codexOAuthAuth } = require('./codex-identity-fixtures');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-rekey-'));
  return root;
}

// registerEmailVectorAccount 按**旧**向量注册账号，模拟改动前已存在的账号。
function registerEmailVectorAccount(root, cliAccountId, email) {
  return registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId,
    identitySeed: `oauth:codex:${email}`
  }).accountRef;
}

// registerCurrentVectorAccount 按**新**向量注册账号。
function registerCurrentVectorAccount(root, cliAccountId, userId) {
  return registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId,
    identitySeed: `oauth:codex:${userId}`
  }).accountRef;
}

function writeCodexAuth(root, accountRef, auth) {
  writeAccountNativeAuth(fs, root, accountRef, { auth });
}

function entryFor(ledger, accountRef) {
  const entry = ledger.entries.find((item) => item.old_account_ref === accountRef);
  assert.ok(entry, `ledger is missing ${accountRef}`);
  return entry;
}

test('an email-vector account with a stable user id is planned as a migration', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerEmailVectorAccount(root, '1', 'worker@example.com');
    writeCodexAuth(root, accountRef, codexOAuthAuth({
      userId: 'worker-user',
      email: 'worker@example.com'
    }));

    const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    assert.equal(summary.total, 1);
    assert.equal(summary.migrate, 1);
    const entry = entryFor(ledger, accountRef);
    assert.equal(entry.resolution, RESOLUTION.MIGRATE);
    assert.equal(entry.old_account_ref, getPublicAccountRef('unique:oauth:codex:worker@example.com'));
    assert.equal(entry.new_account_ref, getPublicAccountRef('unique:oauth:codex:worker-user'));
    assert.equal(entry.identity_seed, 'oauth:codex:worker-user');
    // 邮箱只作为裁决证据出现，不参与身份。
    assert.equal(entry.email, 'worker@example.com');
    assert.equal(entry.identity_seed.includes('@'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an account already on the user_id vector needs no migration', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerCurrentVectorAccount(root, '1', 'worker-user');
    writeCodexAuth(root, accountRef, codexOAuthAuth({ userId: 'worker-user' }));

    const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    assert.equal(summary.already_current, 1);
    assert.equal(summary.migrate, 0);
    const entry = entryFor(ledger, accountRef);
    assert.equal(entry.resolution, RESOLUTION.ALREADY_CURRENT);
    assert.equal(entry.new_account_ref, accountRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two email-vector accounts sharing one user id produce a conflict, never a silent merge', () => {
  const root = makeSandbox();
  try {
    // 邮箱向量把「同一个 user_id、两个邮箱」拆成了两个账号；user_id 向量会把它们合成一个。
    // 这个方向不可逆，所以必须是 conflict 交给人工裁决。
    const first = registerEmailVectorAccount(root, '1', 'worker@example.com');
    const second = registerEmailVectorAccount(root, '2', 'worker-alias@example.com');
    writeCodexAuth(root, first, codexOAuthAuth({ userId: 'worker-user', email: 'worker@example.com' }));
    writeCodexAuth(root, second, codexOAuthAuth({ userId: 'worker-user', email: 'worker-alias@example.com' }));

    const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    assert.equal(summary.migrate, 1);
    assert.equal(summary.conflict, 1);
    const conflict = ledger.entries.find((item) => item.resolution === RESOLUTION.CONFLICT);
    assert.ok(conflict);
    assert.match(conflict.note, /人工裁决/);
    // 两条记录都指向同一个新身份——这正是需要人来决定保留哪一个的原因。
    const migrate = ledger.entries.find((item) => item.resolution === RESOLUTION.MIGRATE);
    assert.equal(conflict.new_account_ref, migrate.new_account_ref);

    const applicability = ledgerIsApplicable(ledger);
    assert.equal(applicability.applicable, false);
    assert.match(applicability.blockers.join(' '), /冲突/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an email-vector account without a stable user id cannot be migrated', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerEmailVectorAccount(root, '1', 'worker@example.com');
    writeCodexAuth(root, accountRef, codexOAuthAuth({
      userId: null,
      email: 'worker@example.com'
    }));

    const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    assert.equal(summary.unverifiable, 1);
    const entry = entryFor(ledger, accountRef);
    assert.equal(entry.resolution, RESOLUTION.UNVERIFIABLE);
    assert.equal(entry.new_account_ref, '');
    assert.equal(ledgerIsApplicable(ledger).applicable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an accountRef on neither known vector is reported, not guessed at', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerEmailVectorAccount(root, '1', 'worker@example.com');
    // 凭据上的邮箱与注册时用的邮箱不同，于是落库的 ref 既不是「凭据邮箱」向量也不是
    // user_id 向量。迁移必须如实报告，而不是按凭据邮箱把它当成邮箱向量去改。
    writeCodexAuth(root, accountRef, codexOAuthAuth({
      userId: 'worker-user',
      email: 'renamed@example.com'
    }));

    const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    assert.equal(summary.unrecognized, 1);
    const entry = entryFor(ledger, accountRef);
    assert.equal(entry.resolution, RESOLUTION.UNRECOGNIZED);
    assert.equal(entry.new_account_ref, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply rewrites every account_ref column and is complete by construction', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerEmailVectorAccount(root, '1', 'worker@example.com');
    writeCodexAuth(root, accountRef, codexOAuthAuth({
      userId: 'worker-user',
      email: 'worker@example.com'
    }));
    const { ledger } = planCodexIdentityRekey({ fs, aiHomeDir: root });
    const newAccountRef = entryFor(ledger, accountRef).new_account_ref;

    // 加一张**不在任何手工清单里**的表：动态枚举必须自己发现它。
    const db = openAppStateDatabase(fs, root, {});
    db.exec('CREATE TABLE synthetic_projection (account_ref TEXT NOT NULL, payload TEXT)');
    db.prepare('INSERT INTO synthetic_projection (account_ref, payload) VALUES (?, ?)')
      .run(accountRef, 'row');
    db.close();

    const targets = (() => {
      const probe = openAppStateDatabase(fs, root, { createIfMissing: false });
      const found = listAccountRefColumns(probe);
      probe.close();
      return found;
    })();
    assert.equal(
      targets.some((t) => t.table === 'synthetic_projection' && t.column === 'account_ref'),
      true,
      'the dynamic scan must find a table that is not in any hand-maintained list'
    );

    const result = applyCodexIdentityRekey({ fs, aiHomeDir: root, ledger });
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'applied');

    // 凭据、注册表和那张新表都必须指向新身份。
    const after = openAppStateDatabase(fs, root, { createIfMissing: false });
    for (const target of targets) {
      const stale = after.prepare(
        `SELECT COUNT(*) AS n FROM ${target.table} WHERE ${target.column} = ?`
      ).get(accountRef);
      assert.equal(Number(stale.n), 0, `${target.table}.${target.column} still references the old ref`);
    }
    after.close();

    const rekeyed = readAccountNativeAuth(fs, root, newAccountRef);
    assert.equal(rekeyed.auth.tokens.refresh_token, 'secret-refresh-token');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply refuses a ledger with unresolved blockers and writes nothing', () => {
  const root = makeSandbox();
  try {
    const first = registerEmailVectorAccount(root, '1', 'worker@example.com');
    const second = registerEmailVectorAccount(root, '2', 'worker-alias@example.com');
    writeCodexAuth(root, first, codexOAuthAuth({ userId: 'worker-user', email: 'worker@example.com' }));
    writeCodexAuth(root, second, codexOAuthAuth({ userId: 'worker-user', email: 'worker-alias@example.com' }));
    const { ledger } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    const result = applyCodexIdentityRekey({ fs, aiHomeDir: root, ledger });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'ledger_has_blockers');
    assert.equal(result.rewritten, 0);

    // 一条都不许动：部分迁移会把账号体系留在分裂状态。
    const db = openAppStateDatabase(fs, root, { createIfMissing: false });
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM account_refs WHERE account_ref = ?')
      .get(first);
    db.close();
    assert.equal(Number(remaining.n), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a ledger with nothing to migrate is a no-op success', () => {
  const root = makeSandbox();
  try {
    const accountRef = registerCurrentVectorAccount(root, '1', 'worker-user');
    writeCodexAuth(root, accountRef, codexOAuthAuth({ userId: 'worker-user' }));
    const { ledger } = planCodexIdentityRekey({ fs, aiHomeDir: root });

    const result = applyCodexIdentityRekey({ fs, aiHomeDir: root, ledger });
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'nothing_to_do');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
