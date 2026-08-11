'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { narrowPoolByModelCatalog } = require('../lib/server/model-pool-narrowing');

const OAUTH_A = 'acct_3306a0fb0bfb1c1127fb';
const OAUTH_B = 'acct_c3ccfeed8592ee54aea8';
const RELAY = 'acct_4c8fc2a7052fbb33d50d';
const FOREIGN = 'acct_646b18bf0617e3682610';

function account(accountRef) {
  return { accountRef };
}

function getAccountRef(provider, item) {
  return String(item && item.accountRef || '');
}

function narrow(overrides = {}) {
  return narrowPoolByModelCatalog({
    pool: [account(OAUTH_A), account(OAUTH_B), account(RELAY)],
    provider: 'codex',
    model: 'gpt-5.6-luna',
    accountRefs: [],
    accountCatalogs: new Map(),
    providerCatalog: null,
    getAccountRef,
    ...overrides
  });
}

test('已知目录里有账号能服务该模型时收窄到这些账号', () => {
  const result = narrow({
    accountRefs: [OAUTH_A, OAUTH_B],
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.6-luna'])],
      [OAUTH_B, new Set(['gpt-5.6-luna'])],
      [RELAY, new Set(['gpt-5.5'])]
    ])
  });
  assert.equal(result.filtered, true);
  assert.deepEqual(result.pool.map((item) => item.accountRef), [OAUTH_A, OAUTH_B]);
});

// 这是线上 503 的回归点：账号级目录只探测到一部分账号（--models-probe-accounts 有预算、
// 账号重载还会整体失效缓存），此时「查不到绑定」不等于「没有账号能服务」。
test('账号目录残缺时放行整池，不合成 no_available_account', () => {
  const result = narrow({
    accountRefs: [],
    accountCatalogs: new Map([[RELAY, new Set(['gpt-5.5'])]])
  });
  assert.equal(result.filtered, false);
  assert.equal(result.unchecked, true);
  assert.equal(result.pool.length, 3);
});

test('provider 目录认识该模型但还没有账号绑定时放行整池', () => {
  const result = narrow({
    accountRefs: [],
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.5'])],
      [OAUTH_B, new Set(['gpt-5.5'])],
      [RELAY, new Set(['gpt-5.5'])]
    ]),
    providerCatalog: new Set(['gpt-5.5', 'gpt-5.6-luna'])
  });
  assert.equal(result.filtered, false);
  assert.equal(result.providerCatalogOnly, true);
  assert.equal(result.pool.length, 3);
});

test('目录给出的账号全不在本池里（跨 provider 同名模型）时放行整池', () => {
  const result = narrow({
    accountRefs: [FOREIGN],
    accountCatalogs: new Map([
      [FOREIGN, new Set(['gpt-5.6-luna'])],
      [OAUTH_A, new Set(['gpt-5.5'])],
      [OAUTH_B, new Set(['gpt-5.5'])],
      [RELAY, new Set(['gpt-5.5'])]
    ])
  });
  assert.equal(result.filtered, false);
  assert.equal(result.unchecked, true);
  assert.equal(result.pool.length, 3);
});

test('池内目录全部已知且都不含该模型时才判定无可用账号', () => {
  const result = narrow({
    accountRefs: [],
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.5'])],
      [OAUTH_B, new Set(['gpt-5.5'])],
      [RELAY, new Set(['gpt-5.5'])]
    ]),
    providerCatalog: new Set(['gpt-5.5'])
  });
  assert.equal(result.filtered, true);
  assert.equal(result.pool.length, 0);
});

test('orderByAccountRefs 保留倒排索引给出的账号优先级', () => {
  const result = narrowPoolByModelCatalog({
    pool: [account(OAUTH_A), account(RELAY)],
    provider: 'codex',
    model: 'gpt-5.6-luna',
    accountRefs: [RELAY, OAUTH_A],
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.6-luna'])],
      [RELAY, new Set(['gpt-5.6-luna', 'gpt-5.5'])]
    ]),
    providerCatalog: null,
    getAccountRef,
    orderByAccountRefs: true
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [RELAY, OAUTH_A]);
});

// 倒排索引路径没有 provider 级目录佐证，原实现「查不到绑定 → unchecked」永远不合成 503。
// 收窄策略统一后必须保住这条语义，否则模型刚上线、账号目录还没收录时会被判成没账号。
test('allowNoAccountVerdict=false 时永不判定无可用账号', () => {
  const result = narrow({
    accountRefs: [],
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.5'])],
      [OAUTH_B, new Set(['gpt-5.5'])],
      [RELAY, new Set(['gpt-5.5'])]
    ]),
    providerCatalog: null,
    allowNoAccountVerdict: false
  });
  assert.equal(result.filtered, false);
  assert.equal(result.unchecked, true);
  assert.equal(result.pool.length, 3);
});
