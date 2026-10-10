'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateUpstreamErrorRules, matchUpstreamErrorRule, readUpstreamErrorRules, ERROR_RULES_ENV_KEY } = require('../lib/account/upstream-error-rules');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');
const { applyAccountFailurePolicy, deriveAccountRuntimeStatus, pickPersistedAccountRuntimeState, applyPersistedAccountRuntimeState } = require('../lib/server/account-runtime-state');
const { markProxyAccountFailure, markProxyAccountSuccess, chooseServerAccount } = require('../lib/server/router');
const { recoverProbedAccounts } = require('../lib/server/account-probe-recovery');
const { createAccountStateService } = require('../lib/account/state-service');

const balanceRule = {
  name: '余额不足', kind: 'billing_blocked', statuses: [403],
  matchers: [{ field: 'code', pattern: '^insufficient_user_quota$' }]
};
const ooiooBody = { error: { message: '用户额度不足, 剩余额度: ＄-0.028880 (request id: fixture)', type: 'new_api_error', code: 'insufficient_user_quota', param: '' } };

test('account rules distinguish same-status errors, AND conditions, first match and disabled rules', () => {
  const rules = validateUpstreamErrorRules([
    { ...balanceRule, matchers: [...balanceRule.matchers, { field: 'message', pattern: '用户额度不足|余额不足' }] },
    { ...balanceRule, name: 'permission', kind: 'permission_denied', matchers: [{ field: 'code', pattern: '^permission_denied$' }] }
  ]);
  assert.equal(matchUpstreamErrorRule(rules, 403, JSON.stringify(ooiooBody)).kind, 'billing_blocked');
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { code: 'permission_denied' } }).kind, 'permission_denied');
  assert.equal(matchUpstreamErrorRule(rules, 403, { error: { code: 'insufficient_user_quota', message: 'different business error' } }), null);
  assert.equal(matchUpstreamErrorRule(rules, 401, ooiooBody), null);
  assert.equal(matchUpstreamErrorRule([{ ...rules[0], enabled: false }, rules[1]], 403, ooiooBody), null);
  assert.equal(matchUpstreamErrorRule([rules[0], { ...rules[0], kind: 'permission_denied' }], 403, ooiooBody), rules[0]);
  const env = { [ERROR_RULES_ENV_KEY]: JSON.stringify(rules) };
  assert.deepEqual(readUpstreamErrorRules(env), rules);
});

test('rules inspect explicit failure frames and plain HTTP failures, never successful answers or user text', () => {
  const rules = validateUpstreamErrorRules([{ ...balanceRule, statuses: [], matchers: [{ field: 'body', pattern: '余额不足' }] }]);
  assert.equal(matchUpstreamErrorRule(rules, 200, { output: '余额不足' }), null);
  assert.equal(matchUpstreamErrorRule(rules, 200, { type: 'response.completed', response: { output: '余额不足' } }), null);
  assert.equal(matchUpstreamErrorRule(rules, 0, { type: 'response.create', input: '余额不足' }), null);
  assert.equal(matchUpstreamErrorRule(rules, 403, '余额不足').kind, 'billing_blocked');
  assert.equal(matchUpstreamErrorRule(rules, 0, { type: 'response.failed', response: { error: { message: '余额不足' } } }).kind, 'billing_blocked');
});

test('visual matcher format combines HTTP, text and nested JSON conditions without conflating 403 errors', () => {
  const rules = validateUpstreamErrorRules([{
    ...balanceRule,
    matchers: [
      { source: 'http_code', operator: 'equals', value: '403' },
      { source: 'json', path: 'error.type', operator: 'equals', value: 'new_api_error' },
      { source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' },
      { source: 'body', operator: 'contains', value: '用户额度不足' }
    ]
  }]);
  assert.equal(matchUpstreamErrorRule(rules, 403, ooiooBody).kind, 'billing_blocked');
  for (const body of [
    { error: { ...ooiooBody.error, code: 'permission_denied' } },
    { error: { ...ooiooBody.error, type: 'invalid_request_error' } }
  ]) assert.equal(matchUpstreamErrorRule(rules, 403, body), null);

  const nested = validateUpstreamErrorRules([{
    ...balanceRule,
    matchers: [
      { source: 'json', path: 'data.a', operator: 'equals', value: 1 },
      { source: 'json', path: 'data.items[0].b', operator: 'equals', value: 2 },
      { source: 'json', path: 'data.items[0].code', operator: 'regex', value: '^quota_' },
      { source: 'http_code', operator: 'contains', value: '40' }
    ]
  }]);
  assert.equal(matchUpstreamErrorRule(nested, 403, { data: { a: 1, items: [{ b: 2, code: 'quota_empty' }] } }).kind, 'billing_blocked');
  assert.equal(matchUpstreamErrorRule(nested, 403, { data: { a: 1, items: [{ b: 3, code: 'quota_empty' }] } }), null);
  const missing = validateUpstreamErrorRules([{ ...balanceRule,
    matchers: [{ source: 'json', path: 'error.toString', operator: 'regex', value: '.*' },
      { source: 'json', path: 'error.toString', operator: 'equals', value: null }] }]);
  assert.equal(matchUpstreamErrorRule(missing, 403, { error: {} }), null);
  assert.throws(() => validateUpstreamErrorRules([{ ...balanceRule,
    matchers: [{ source: 'json', path: 'error.code', operator: 'equals' }] }]), { code: 'invalid_upstream_error_rules' });
});

test('invalid, oversized and backtracking rules are rejected before saving', () => {
  for (const pattern of ['(', '[', '(a+)+$', 'a*a*$', 'a+b', 'a+$', '\\1', 'x'.repeat(257)]) {
    assert.throws(() => validateUpstreamErrorRules([{ ...balanceRule, matchers: [{ field: 'message', pattern }] }]), { code: 'invalid_upstream_error_rules' });
  }
  for (const rule of [
    { ...balanceRule, kind: 'invented' }, { ...balanceRule, statuses: [200] },
    { ...balanceRule, matchers: [] }, { ...balanceRule, statuses: ['403'] }
  ]) assert.throws(() => validateUpstreamErrorRules([rule]), { code: 'invalid_upstream_error_rules' });
  assert.throws(() => validateUpstreamErrorRules(Array(21).fill(balanceRule)));
});

test('configured billing block persists, survives models success and cannot be bypassed by affinity or last resort', () => {
  const account = { accountRef: 'acct_0123456789abcdef0123', provider: 'codex', apiKeyMode: true, upstreamErrorRules: validateUpstreamErrorRules([balanceRule]) };
  const policy = classifyUpstreamFailure({ provider: 'codex', account, statusCode: 403, body: JSON.stringify(ooiooBody) });
  assert.equal(policy.kind, 'billing_blocked');
  assert.equal(policy.scope, 'account');
  assert.equal(policy.shouldUnbindSession, true);
  applyAccountFailurePolicy(account, policy, { model: 'gpt-6.1-sol', markProxyAccountFailure });
  const restored = applyPersistedAccountRuntimeState({ ...account }, pickPersistedAccountRuntimeState(account));
  markProxyAccountSuccess(restored, { model: 'other-model' });
  assert.equal(deriveAccountRuntimeStatus(restored, Date.now() + 365 * 86400000).status, 'billing_blocked');
  assert.deepEqual(recoverProbedAccounts({ accounts: { codex: [restored] } }, {
    byAccount: { [account.accountRef]: ['gpt-6.1-sol'] }, sourcesByAccount: { [account.accountRef]: 'remote' }
  }, { listAccountModelCacheRefs: () => [account.accountRef] }), []);
  assert.equal(chooseServerAccount([restored], {}, 'codex', {
    model: 'other-model', allowModelCooled: true, preserveEncryptedReasoningAffinity: true
  }), null);

  let runtimeState = pickPersistedAccountRuntimeState(restored);
  const service = createAccountStateService({ accountStateIndex: {
    getAccountState: () => ({ runtimeState }),
    upsertRuntimeState: (_ref, _provider, next) => { runtimeState = next; return true; }
  } });
  for (const evidence of ['models_probe_success', 'token_refresh_success', 'api_key_config_verified', 'upstream_success']) {
    assert.equal(service.clearRuntimeBlock(account.accountRef, 'codex', { evidence }), false);
  }
  assert.equal(service.clearRuntimeBlock(account.accountRef, 'codex', { evidence: 'manual_admin_clear' }), true);
  assert.equal(runtimeState, null);
});

test('unmatched 403 and structured safety rejection keep existing semantics', () => {
  const account = { apiKeyMode: true, upstreamErrorRules: validateUpstreamErrorRules([balanceRule]) };
  assert.equal(classifyUpstreamFailure({ provider: 'codex', account, statusCode: 403, body: { error: { code: 'other' } } }).kind, 'auth_invalid');
  const wildcard = validateUpstreamErrorRules([{ ...balanceRule, matchers: [{ field: 'body', pattern: '.*' }] }]);
  assert.equal(classifyUpstreamFailure({ provider: 'codex', account: { ...account, upstreamErrorRules: wildcard }, statusCode: 403, body: { error: { code: 'safety_rejected' } } }).kind, 'safety_rejected');
});
