const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../lib/server/codex-adapter');

const { resolvePinnedCodexPool } = __private;
const NOW = Date.now();

function account(accountRef, extra = {}) {
  return { accountRef, provider: 'codex', apiKeyMode: false, schedulableStatus: 'schedulable', ...extra };
}

// 回归：Codex App 钉住的中转账号（x-account-ref）对 gpt-5.6-sol 处于模型冷却，旧实现仍只给
// 它一个候选，会话每轮 503「no schedulable codex account: model_cooldown」，别的账号明明能用。
test('pinned account in model cooldown falls back to the whole codex pool', () => {
  const pinned = account('acct_d62c5c4961277f9403c8', {
    apiKeyMode: true,
    modelCooldowns: { 'gpt-5.6-sol': NOW + 60 * 60 * 1000 },
    lastError: 'model_not_available_on_endpoint'
  });
  const oauth = account('acct_55865084c85f0c4b34d3');
  const pool = resolvePinnedCodexPool([pinned, oauth], pinned.accountRef, 'gpt-5.6-sol', {}, {});
  assert.deepEqual(pool.map((item) => item.accountRef), [pinned.accountRef, oauth.accountRef]);
});

test('healthy pinned account stays exclusive', () => {
  const pinned = account('acct_d62c5c4961277f9403c8');
  const other = account('acct_55865084c85f0c4b34d3');
  const pool = resolvePinnedCodexPool([pinned, other], pinned.accountRef, 'gpt-5.6-sol', {}, {});
  assert.deepEqual(pool.map((item) => item.accountRef), [pinned.accountRef]);
});

test('pinned account whose catalog lacks the model falls back to the pool', () => {
  const pinned = account('acct_d62c5c4961277f9403c8', { apiKeyMode: true });
  const oauth = account('acct_55865084c85f0c4b34d3');
  const state = {
    modelAccountIndex: {
      builtAt: NOW,
      accountToModels: new Map([
        [pinned.accountRef, new Set(['gpt-6-astra'])],
        [oauth.accountRef, new Set(['gpt-5.6-sol'])]
      ]),
      modelToAccounts: new Map([['gpt-5.6-sol', new Set([oauth.accountRef])]])
    }
  };
  const pool = resolvePinnedCodexPool([pinned, oauth], pinned.accountRef, 'gpt-5.6-sol', state, {});
  assert.equal(pool.length, 2);
});

test('unpinned requests and unknown pins keep existing behavior', () => {
  const accounts = [account('acct_d62c5c4961277f9403c8'), account('acct_55865084c85f0c4b34d3')];
  assert.equal(resolvePinnedCodexPool(accounts, '', 'gpt-5.6-sol', {}, {}), accounts);
  assert.deepEqual(resolvePinnedCodexPool(accounts, 'acct_ffffffffffffffffffff', 'gpt-5.6-sol', {}, {}), []);
});
