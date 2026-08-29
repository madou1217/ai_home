'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  excludeAccountsWithoutModel,
  narrowPoolByModelCatalog
} = require('../lib/server/model-pool-narrowing');

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

test('provider 明确判定额度耗尽时，即使目录仍存在也不把账号放回上游池', () => {
  const accountRef = 'acct_quota_exhausted';
  const result = narrowPoolByModelCatalog({
    pool: [account(accountRef)],
    provider: 'agy',
    model: 'claude-opus-4-6-thinking',
    accountRefs: [],
    knownAccountRefs: [accountRef],
    blockedAccountRefs: [accountRef],
    accountCatalogs: new Map([[accountRef, new Set(['claude-opus-4-6-thinking'])]]),
    providerCatalog: new Set(['claude-opus-4-6-thinking']),
    getAccountRef
  });

  assert.deepEqual(result.pool, []);
  assert.equal(result.filtered, true);
  assert.equal(result.blockedByUsage, true);
});

// 回归：账号个个健康却一个都没选中，只可能是「按模型选账号」把它们滤光了。
// 旧文案会说 "no schedulable X account: unknown"，把「没人支持这个模型」说成
// 「没有可调度账号」，排障会一路找错方向。
const { summarizeAccountAvailability } = require('../lib/server/account-availability');

test('账号全健康但按模型选不出时，文案要说清是模型不支持', () => {
  const healthy = [
    { accountRef: OAUTH_A, accessToken: 't', schedulableStatus: 'schedulable' },
    { accountRef: OAUTH_B, accessToken: 't', schedulableStatus: 'schedulable' }
  ];
  const summary = summarizeAccountAvailability(healthy, {
    provider: 'agy',
    model: 'claude-fable-5'
  });
  assert.equal(summary.available, 2);
  assert.match(summary.detail, /no agy account can serve model claude-fable-5/);
  assert.doesNotMatch(summary.detail, /unknown/);
});

test('确有不可用原因时保持原有诊断文案', () => {
  const cooled = [
    { accountRef: OAUTH_A, accessToken: 't', schedulableStatus: 'schedulable', cooldownUntil: Date.now() + 60000, lastError: 'rate_limited' }
  ];
  const summary = summarizeAccountAvailability(cooled, { provider: 'agy', model: 'x' });
  assert.equal(summary.available, 0);
  assert.match(summary.detail, /no schedulable agy account: cooldown:rate_limited=1/);
});

const OLLAMA = 'acct_52facbdf93d7161b990d';

function exclude(overrides = {}) {
  return excludeAccountsWithoutModel({
    pool: [account(OAUTH_A), account(OLLAMA)],
    provider: 'codex',
    model: 'gpt-5.6-luna',
    accountCatalogs: new Map(),
    getAccountRef,
    ...overrides
  });
}

test('目录已知且不含该模型的账号被剔除', () => {
  const result = exclude({
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.6-luna', 'gpt-5.5'])],
      [OLLAMA, new Set(['kimi-k3', 'qwen3.5:397b', 'glm-5.2'])]
    ])
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [OAUTH_A]);
  assert.deepEqual(result.excludedAccountRefs, [OLLAMA]);
});

test('目录未知或为空的账号一律放行——探测残缺不是否定证据', () => {
  const result = exclude({
    accountCatalogs: new Map([
      [OAUTH_A, new Set()],
      [RELAY, new Set(['gpt-5.5'])]
    ])
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [OAUTH_A, OLLAMA]);
  assert.deepEqual(result.excludedAccountRefs, []);
});

test('版本分隔符变体不算不支持', () => {
  const result = exclude({
    model: 'gpt-5-6-luna',
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.6-luna'])],
      [OLLAMA, new Set(['kimi-k3'])]
    ])
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [OAUTH_A]);
});

test('全池目录都已知且都不含该模型时排空——由调用方给出终判', () => {
  const result = exclude({
    accountCatalogs: new Map([
      [OAUTH_A, new Set(['gpt-5.5'])],
      [OLLAMA, new Set(['kimi-k3'])]
    ])
  });
  assert.deepEqual(result.pool, []);
  assert.deepEqual(result.excludedAccountRefs, [OAUTH_A, OLLAMA]);
});

test('原生生图模型不会因常规文本目录缺失而被误排除', () => {
  const AGY_REF = 'acct_03f68577e90ee8c1f577';
  const result = excludeAccountsWithoutModel({
    pool: [account(AGY_REF)],
    provider: 'agy',
    model: 'gemini-3.1-flash-image',
    accountCatalogs: new Map([
      [AGY_REF, new Set(['gemini-2.5-pro', 'gemini-2.5-flash'])]
    ]),
    getAccountRef
  });
  assert.deepEqual(result.pool.map((item) => item.accountRef), [AGY_REF]);
  assert.deepEqual(result.excludedAccountRefs, []);
});
