'use strict';

// 编辑 API Key 账号(重新保存密钥)后,旧密钥上的 auth_invalid 证据作废,
// 账号必须回到可调度;此前该清除只认 OAuth,API Key 账号改完密钥仍显示「认证失效」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');

function setup(t, lastFailureAt) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-apikey-clear-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex', identitySeed: 'api_key:codex:https://relay.example.com/v1:0123456789abcdef'
  });
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    OPENAI_API_KEY: 'sk-relay-key', OPENAI_BASE_URL: 'https://relay.example.com/v1'
  });
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => accountStateIndex.close());
  const accountStateService = createAccountStateService({ fs, accountStateIndex });
  accountStateIndex.upsertRuntimeState(accountRef, 'codex', {
    authInvalidUntil: Date.now() + 365 * 86400000,
    cooldownUntil: Date.now() + 365 * 86400000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required',
    lastFailureAt
  }, { configured: true, status: 'up', apiKeyMode: true, authMode: 'api-key' });
  const load = () => loadServerRuntimeAccounts({
    fs, aiHomeDir, accountStateIndex, accountStateService,
    getProfileDir: () => '', checkStatus: () => ({ configured: true })
  }).codex.find((account) => account.accountRef === accountRef);
  return { accountRef, accountStateService, load };
}

test('API Key 账号在失效之后重新保存密钥,auth_invalid 被清除', (t) => {
  const f = setup(t, Date.now() - 60_000);
  const account = f.load();
  assert.ok(account, 'api-key account should load');
  assert.equal(f.accountStateService.getAccountState(f.accountRef).runtimeState.authInvalidUntil, 0);
});

test('失效晚于最近一次保存密钥时,auth_invalid 保留(新证据不能被旧保存抹掉)', (t) => {
  const f = setup(t, Date.now() + 60_000);
  f.load();
  assert.ok(f.accountStateService.getAccountState(f.accountRef).runtimeState.authInvalidUntil > Date.now());
});
