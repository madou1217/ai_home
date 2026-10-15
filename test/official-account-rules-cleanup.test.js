'use strict';

// 一次性迁移：清掉官方上游 / OAuth 账号上的调度规则（死配置），保留第三方上游账号的规则。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyOfficialAccountRulesCleanup,
  planOfficialAccountRulesCleanup
} = require('../lib/account/official-account-rules-cleanup');
const {
  readAccountCredentials,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

const RULES = [{ name: 'New API 余额不足', enabled: true, statuses: [403], kind: 'billing_blocked',
  matchers: [{ source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }] }];

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rules-cleanup-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function register(aiHomeDir, provider, cliAccountId, env) {
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: String(cliAccountId),
    identitySeed: `fixture:${provider}:${cliAccountId}`
  });
  writeAccountCredentials(fs, aiHomeDir, accountRef, env);
  return accountRef;
}

test('plan keeps third-party upstream rules and lists official/OAuth ones for cleanup', (t) => {
  const aiHomeDir = createFixture(t);
  const oauthRef = register(aiHomeDir, 'codex', '1', { AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES) });
  const officialRef = register(aiHomeDir, 'codex', '2', {
    OPENAI_API_KEY: 'sk-official',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES),
    AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify(['g_new_api'])
  });
  const thirdPartyRef = register(aiHomeDir, 'codex', '3', {
    OPENAI_API_KEY: 'sk-relay',
    OPENAI_BASE_URL: 'https://relay.example.com/v1',
    AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES)
  });
  const cleanRef = register(aiHomeDir, 'claude', '4', { ANTHROPIC_API_KEY: 'sk-clean' });

  const plan = planOfficialAccountRulesCleanup({ fs, aiHomeDir });
  assert.equal(plan.scannedAccounts, 4);
  assert.equal(plan.accountsWithRules, 3);
  // 顺序按 account_ref 排序（凭据表口径），所以这里按 accountRef 归一后比较。
  const plannedByRef = new Map(plan.planned.map((entry) => [entry.accountRef, entry.reason]));
  assert.deepEqual([...plannedByRef.entries()].sort(), [
    [oauthRef, 'oauth_login'],
    [officialRef, 'official_host:api.openai.com']
  ].sort());
  assert.deepEqual(plan.kept.map((entry) => entry.accountRef), [thirdPartyRef]);
  assert.equal(plannedByRef.size, 2);
  // 演练不写库。
  assert.ok(readAccountCredentials(fs, aiHomeDir, oauthRef).AIH_UPSTREAM_ERROR_RULES);
  assert.ok(readAccountCredentials(fs, aiHomeDir, officialRef).AIH_UPSTREAM_ERROR_RULES);
  assert.equal(readAccountCredentials(fs, aiHomeDir, cleanRef).ANTHROPIC_API_KEY, 'sk-clean');
});

test('apply removes only the two rule keys, keeps the rest of the env, and writes a restorable backup', (t) => {
  const aiHomeDir = createFixture(t);
  const oauthRef = register(aiHomeDir, 'codex', '1', {
    OPENAI_API_KEY: 'sk-oauth-kept',
    AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES),
    AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify(['g_new_api'])
  });
  const thirdPartyRef = register(aiHomeDir, 'codex', '3', {
    OPENAI_API_KEY: 'sk-relay',
    OPENAI_BASE_URL: 'https://relay.example.com/v1',
    AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES)
  });

  const result = applyOfficialAccountRulesCleanup({ fs, aiHomeDir, nowMs: 1_700_000_000_000 });
  assert.deepEqual(result.applied.map((entry) => entry.accountRef), [oauthRef]);
  assert.deepEqual(result.failed, []);

  const cleaned = readAccountCredentials(fs, aiHomeDir, oauthRef);
  assert.equal(cleaned.AIH_UPSTREAM_ERROR_RULES, undefined);
  assert.equal(cleaned.AIH_UPSTREAM_ERROR_GROUP_IDS, undefined);
  assert.equal(cleaned.OPENAI_API_KEY, 'sk-oauth-kept', '其它 env 键必须原样保留');

  const kept = readAccountCredentials(fs, aiHomeDir, thirdPartyRef);
  assert.deepEqual(JSON.parse(kept.AIH_UPSTREAM_ERROR_RULES), RULES, '第三方上游账号的规则必须保留');

  const backup = JSON.parse(fs.readFileSync(result.backupFile, 'utf8'));
  assert.equal(backup.accounts.length, 1);
  assert.equal(backup.accounts[0].accountRef, oauthRef);
  assert.deepEqual(backup.accounts[0].AIH_UPSTREAM_ERROR_RULES, RULES);
  assert.deepEqual(backup.accounts[0].AIH_UPSTREAM_ERROR_GROUP_IDS, ['g_new_api']);
});

test('the migration is idempotent — a second run plans nothing', (t) => {
  const aiHomeDir = createFixture(t);
  register(aiHomeDir, 'codex', '1', { AIH_UPSTREAM_ERROR_RULES: JSON.stringify(RULES) });
  applyOfficialAccountRulesCleanup({ fs, aiHomeDir });
  const again = applyOfficialAccountRulesCleanup({ fs, aiHomeDir });
  assert.deepEqual(again.planned, []);
  assert.deepEqual(again.applied, []);
  assert.equal(again.backupFile, '', '无写入时不应产生备份文件');
});
