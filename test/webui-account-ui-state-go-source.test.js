'use strict';

// 账号页展示字段（authMode / apiKeyMode / oauth_pending / configured）固定读 Go 物化的
// account_ui_state。这组用例锁三件事：
//   1) Go 有这一行时以 Go 为准：状态行、凭据、checkStatus 的旧结论一律不参与；
//   2) Go 还没写这一行时沿用状态行里的上次值，不再按凭据 / checkStatus 现场推导；
//   3) 待登录只认 Go 的 oauth_pending：状态行长得像「待登录」也不再本地推导。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  buildPersistedAccountState,
  isPendingOauthStateRow
} = require('../lib/server/webui-account-routes-state');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { __private } = require('../lib/server/webui-account-live');

const { withGoUIState, buildNodeBaseAccountRecord } = __private;

const ACCOUNT_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ui-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Go 侧的 account_ui_state（schema_v13 + v15）：Node 只读，这里按同一列名造库。
function writeGoUIState(dir, row) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS account_ui_state (
    account_ref TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'up',
    display_name TEXT NOT NULL DEFAULT '',
    auth_mode TEXT NOT NULL DEFAULT '',
    api_key_mode INTEGER NOT NULL DEFAULT 0,
    base_url TEXT NOT NULL DEFAULT '',
    updated_at_ms INTEGER NOT NULL,
    configured INTEGER NOT NULL DEFAULT 0,
    oauth_pending INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare(`INSERT OR REPLACE INTO account_ui_state
    (account_ref, status, display_name, auth_mode, api_key_mode, base_url, updated_at_ms, configured, oauth_pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ACCOUNT_REF,
    String(row.status || 'up'),
    String(row.displayName || ''),
    String(row.authMode || ''),
    row.apiKeyMode ? 1 : 0,
    '',
    Number(row.updatedAtMs) || 0,
    row.configured ? 1 : 0,
    row.oauthPending ? 1 : 0
  );
  db.close();
}

// checkStatus 仍带 configured：它已经不再参与展示字段，测试用它来证明「没有兜底」。
function createCtx(dir) {
  return {
    fs,
    state: {},
    deps: { aiHomeDir: dir },
    checkStatus: () => ({ configured: true, accountName: 'Probe Name' })
  };
}

function overlayWithUIState(state) {
  return {
    get: () => null,
    uiState: (accountRef) => (String(accountRef) === ACCOUNT_REF ? state : null),
    runtimeState: () => null,
    signature: () => ''
  };
}

function pickUIState(record) {
  return {
    authMode: record.authMode,
    apiKeyMode: record.apiKeyMode,
    configured: record.configured,
    oauthPending: record.oauthPending
  };
}

test('Go 物化值优先：状态行与 checkStatus 的旧结论都不参与', (t) => {
  const dir = tmp(t);
  writeGoUIState(dir, { authMode: 'api-key', apiKeyMode: true, configured: true, updatedAtMs: 5_000 });

  const state = buildPersistedAccountState(createCtx(dir), 'claude', ACCOUNT_REF, {
    status: 'up',
    configured: false,
    apiKeyMode: false,
    authMode: 'oauth',
    updatedAt: 1_000
  });

  assert.equal(state.configured, true);
  assert.equal(state.apiKeyMode, true);
  assert.equal(state.authMode, 'api-key');
});

test('Go 没有这一行时沿用状态行上次值，不按凭据推导', (t) => {
  const dir = tmp(t);
  // 凭据里放一把 API Key：旧的 detectStoredApiKeyMode 回退会因此把 apiKeyMode 判成 true。
  const accountRef = upsertAccountRef(fs, dir, {
    provider: 'claude',
    cliAccountId: '1',
    identitySeed: 'claude:ui-state-test'
  });
  writeAccountCredentials(fs, dir, accountRef, { ANTHROPIC_API_KEY: 'sk-ant-ui-state-test' });

  const state = buildPersistedAccountState(createCtx(dir), 'claude', accountRef, {
    status: 'up',
    configured: true,
    apiKeyMode: false,
    authMode: 'oauth',
    updatedAt: 1_000
  });

  assert.equal(state.apiKeyMode, false, 'Go 没写这一行，不能回落到凭据推导');
  assert.equal(state.authMode, 'oauth');
  assert.equal(state.configured, true);
});

test('Go 副本比状态行旧时以状态行为准（刚写完还没同步过去）', (t) => {
  const dir = tmp(t);
  writeGoUIState(dir, { authMode: 'oauth', apiKeyMode: false, configured: true, updatedAtMs: 1_000 });

  const state = buildPersistedAccountState(createCtx(dir), 'claude', ACCOUNT_REF, {
    status: 'up',
    configured: true,
    apiKeyMode: true,
    authMode: 'api-key',
    updatedAt: 2_000
  });

  assert.equal(state.apiKeyMode, true);
  assert.equal(state.authMode, 'api-key');
});

test('checkStatus 不再兜底 configured：Go 与状态行都没有值时按未配置', (t) => {
  const dir = tmp(t);
  const state = buildPersistedAccountState(createCtx(dir), 'claude', ACCOUNT_REF, {
    status: 'up',
    updatedAt: 1_000
  });

  assert.equal(state.configured, false);
  assert.equal(state.apiKeyMode, false);
});

test('待登录只认 Go 物化的 oauth_pending', () => {
  assert.equal(
    isPendingOauthStateRow('claude', null, { oauthPending: true, updatedAtMs: 1_000 }),
    true
  );
  assert.equal(
    isPendingOauthStateRow('claude', null, { oauthPending: false, updatedAtMs: 1_000 }),
    false
  );
  // 状态行长得像「待登录」（未配置 + OAuth 认证方式）也不再本地推导。
  const pendingShapedRow = { configured: false, apiKeyMode: false, authMode: 'oauth', updatedAt: 2_000 };
  assert.equal(isPendingOauthStateRow('claude', pendingShapedRow, null), false);
  assert.equal(
    isPendingOauthStateRow('claude', pendingShapedRow, { oauthPending: true, updatedAtMs: 1_000 }),
    false,
    'Go 副本比状态行旧时同样不采用'
  );
});

test('账号行展示字段：Go 的四项整体覆盖状态行，其它字段原样保留', () => {
  const ctx = {
    state: {
      goRuntimeOverlay: overlayWithUIState({
        authMode: 'api-key',
        apiKeyMode: true,
        configured: true,
        oauthPending: true,
        updatedAtMs: 5_000
      })
    }
  };

  const merged = withGoUIState(ctx, ACCOUNT_REF, {
    status: 'up',
    authMode: 'oauth',
    apiKeyMode: false,
    configured: false,
    updatedAt: 1_000
  });

  assert.deepEqual(pickUIState(merged), {
    authMode: 'api-key',
    apiKeyMode: true,
    configured: true,
    oauthPending: true
  });
  assert.equal(merged.status, 'up');
  assert.equal(merged.updatedAt, 1_000);
});

test('Go 不可用时展示字段保持状态行上次值（不再本地计算）', () => {
  const base = { status: 'up', authMode: 'oauth', apiKeyMode: false, configured: true, updatedAt: 1_000 };
  const merged = withGoUIState({}, ACCOUNT_REF, base);

  assert.equal(merged.authMode, 'oauth');
  assert.equal(merged.apiKeyMode, false);
  assert.equal(merged.configured, true);
  // 状态行没有 oauthPending 这一列：留空即可，不在 Node 侧补算。
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'oauthPending'), false);
});

test('账号行不再按凭据 / 运行池推导：凭据里是 API Key，状态行说不是就不是', (t) => {
  const dir = tmp(t);
  const record = buildNodeBaseAccountRecord(createCtx(dir), {
    provider: 'claude',
    accountRef: ACCOUNT_REF,
    // 凭据是 API Key；旧实现会据此把 apiKeyMode 推成 true。
    credentialRecord: {
      accountRef: ACCOUNT_REF,
      provider: 'claude',
      env: { ANTHROPIC_API_KEY: 'sk-ant-ui-state-test' }
    },
    stateInfo: {
      accountRef: ACCOUNT_REF,
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth',
      updatedAt: 1_000
    },
    runtimeAccount: null,
    cachedRecord: null
  });

  assert.equal(record.apiKeyMode, false);
  assert.equal(record.configured, true);
  assert.equal(record.authMode, 'oauth');
  assert.equal(record.authPending, false);
});
