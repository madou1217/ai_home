'use strict';

// Go 物化的账号额度状态是 Node 服务端与 CLI 的共同读入口。
// 这里锁住读取形状与「旧库没有列时安全回退」，避免 CLI 在迁移窗口里崩掉。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readGoQuotaStates } = require('../lib/account/go-bridge/go-account-store-reader');
const { deriveQuotaState } = require('../lib/account/derived-state');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-quota-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createDb(dir, options = {}) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec(`CREATE TABLE account_usage_snapshots (
    account_ref TEXT PRIMARY KEY,
    captured_at_ms INTEGER NOT NULL DEFAULT 0
    ${options.withState ? `,
    quota_status TEXT NOT NULL DEFAULT '',
    quota_reason TEXT NOT NULL DEFAULT '',
    remaining_bps INTEGER,
    has_numeric_remaining INTEGER NOT NULL DEFAULT 0` : ''}
  )`);
  return db;
}

test('persisted quota states are exposed with pct and capture time', (t) => {
  const dir = tmp(t);
  const db = createDb(dir, { withState: true });
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason, remaining_bps, has_numeric_remaining)
    VALUES (?, ?, ?, ?, ?, ?)`).run('acct_aaaaaaaaaaaaaaaaaaaa', 1793800000000, 'pending', 'codex_team_plan_pending_rate_limits', null, 0);
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason, remaining_bps, has_numeric_remaining)
    VALUES (?, ?, ?, ?, ?, ?)`).run('acct_bbbbbbbbbbbbbbbbbbbb', 1793800000001, 'available', '', 4250, 1);
  db.prepare(`INSERT INTO account_usage_snapshots
    (account_ref, captured_at_ms, quota_status, quota_reason)
    VALUES (?, ?, ?, ?)`).run('acct_cccccccccccccccccccc', 1, '', '');
  db.close();

  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, true);
  assert.equal(states.size, 2, 'rows without a derived state are skipped');
  assert.deepEqual(states.get('acct_aaaaaaaaaaaaaaaaaaaa'), {
    status: 'pending',
    reason: 'codex_team_plan_pending_rate_limits',
    remainingPct: null,
    hasNumericRemaining: false,
    capturedAtMs: 1793800000000
  });
  assert.equal(states.get('acct_bbbbbbbbbbbbbbbbbbbb').remainingPct, 42.5);
  assert.equal(states.get('acct_bbbbbbbbbbbbbbbbbbbb').hasNumericRemaining, true);
});

test('a pre-v12 database without the state columns falls back safely', (t) => {
  const dir = tmp(t);
  const db = createDb(dir, { withState: false });
  db.prepare('INSERT INTO account_usage_snapshots (account_ref, captured_at_ms) VALUES (?, ?)')
    .run('acct_aaaaaaaaaaaaaaaaaaaa', 1);
  db.close();

  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, true);
  assert.equal(states.size, 0);
});

test('a missing database reads as empty', (t) => {
  const dir = tmp(t);
  const { exists, states } = readGoQuotaStates(dir);
  assert.equal(exists, false);
  assert.equal(states.size, 0);
});

test('Node no longer derives codex team/free pending reasons', () => {
  // Go 的 DeriveQuotaState 是这两个原因的唯一实现；Node 的本地推导只保留通用结论。
  for (const planType of ['team', 'free']) {
    const state = deriveQuotaState({
      provider: 'codex',
      configured: true,
      apiKeyMode: false,
      planType,
      usageSnapshot: {
        kind: 'codex_oauth_status',
        source: 'codex_account_read',
        fallbackSource: 'account_read',
        capturedAt: 1,
        entries: []
      }
    });
    assert.equal(state.status, 'pending');
    assert.equal(state.reason, 'provider_returned_no_numeric_usage');
  }
});

// Go 独有账号（Node 账号库没有、Go 有）的启动解析与凭据还原：
// 少了这条路径，`aih agy 1` 会在“账号不存在”和“待登录”之间打转。
const {
  readGoAccountByCliId,
  readGoNativeAuth
} = require('../lib/account/go-bridge/go-native-auth');

function createAccountDb(dir) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec(`
    CREATE TABLE accounts (
      account_ref TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
      cli_account_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE account_credentials (
      account_ref TEXT PRIMARY KEY, auth_kind TEXT, auth_mode TEXT,
      credential_json TEXT, updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE account_profiles (
      account_ref TEXT PRIMARY KEY, profile_json TEXT, email TEXT, subscription_raw TEXT
    );
    CREATE TABLE account_defaults (provider_id TEXT PRIMARY KEY, account_ref TEXT);
    CREATE TABLE account_models (account_ref TEXT, model_id TEXT, manual_policy TEXT);
  `);
  return db;
}

test('Go 独有 agy 账号：按数字别名解析并还原成 Node 原生登录态', (t) => {
  const dir = tmp(t);
  const db = createAccountDb(dir);
  db.prepare('INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled) VALUES (?, ?, ?, ?)')
    .run('acct_agy0000000000000000', 'agy', 1, 1);
  db.prepare('INSERT INTO account_credentials (account_ref, auth_kind, auth_mode, credential_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run('acct_agy0000000000000000', 'oauth', 'consumer', JSON.stringify({
      email: 'madou1217@126.com',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_at_ms: 1794386000000,
      refreshed_at_ms: 1794385900000,
      auth_method: 'consumer'
    }), 1794385900000);
  db.close();

  const account = readGoAccountByCliId(dir, 'agy', '1', { fs });
  assert.equal(account && account.accountRef, 'acct_agy0000000000000000');

  const nativeAuth = readGoNativeAuth(dir, 'acct_agy0000000000000000', { fs });
  assert.equal(nativeAuth.email, 'madou1217@126.com');
  assert.equal(nativeAuth.oauthToken.auth_method, 'consumer');
  assert.equal(nativeAuth.oauthToken.token.access_token, 'access-token');
  assert.equal(nativeAuth.oauthToken.token.refresh_token, 'refresh-token');
  assert.equal(nativeAuth.oauthToken.token.expires_at_ms, 1794386000000);
  assert.equal(new Date(nativeAuth.oauthToken.token.expiry).getTime(), 1794386000000);
});

test('Go 账号：native_auth_json 信封原样还原，不认识的形态返回 null', (t) => {
  const dir = tmp(t);
  const db = createAccountDb(dir);
  db.prepare('INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled) VALUES (?, ?, ?, ?)')
    .run('acct_cline00000000000000', 'cline', 2, 1);
  db.prepare('INSERT INTO account_credentials (account_ref, auth_kind, auth_mode, credential_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run('acct_cline00000000000000', 'oauth', 'native_auth_json',
      JSON.stringify({ native_auth_json: { auth: { providers: {} } } }), 1);
  db.prepare('INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled) VALUES (?, ?, ?, ?)')
    .run('acct_static0000000000000', 'codex', 3, 1);
  db.prepare('INSERT INTO account_credentials (account_ref, auth_kind, auth_mode, credential_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run('acct_static0000000000000', 'api_key', '', JSON.stringify({ api_key: 'sk-x' }), 1);
  db.close();

  assert.deepEqual(
    readGoNativeAuth(dir, 'acct_cline00000000000000', { fs }),
    { auth: { providers: {} } }
  );
  assert.equal(readGoNativeAuth(dir, 'acct_static0000000000000', { fs }), null);
  assert.equal(readGoAccountByCliId(dir, 'agy', '9', { fs }), null);
});
