'use strict';

// CodeBuddy 家族配额探测（Remaining）的契约测试。
//
// 这里锁的是**实测出来的**接口形状与两个坑，任何一条改动都意味着上游接口变了：
//   1. 路径不带 `/v2`（带 /v2 是 404）；
//   2. 国内站必须带真实 User-Agent（脚本默认 UA 会被 WAF 判 403 + code 10085）；
//   3. 必带 X-User-Id / X-Domain 两个头（缺一个也是 10085）；
//   4. 账号级额度是**多包求和**，不是包间取 min。

const test = require('node:test');
const { credential: familyCredential } = require('./helpers/codebuddy-credential');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountCredentialRecord,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_CODEBUDDY,
  getMinRemainingPctFromUsageSnapshot,
  getUsageRemainingPctValues
} = require('../lib/account/usage-remaining');
const {
  CODEBUDDY_FAMILY_PROVIDERS,
  CODEBUDDY_RESOURCE_SUMMARY_PATH,
  resolveCodebuddyFamilyAuthPath,
  resolveCodebuddyFamilyBillingEndpoint,
  resolveCodebuddyCommodityLabel,
  resolveCodebuddyPaidPlanLabel,
  isCodebuddyFamilyProvider
} = require('../lib/account/codebuddy-billing');
const {
  createCodebuddyQuotaProbe,
  CODEBUDDY_PROBE_USER_AGENT,
  readCodebuddySharedCredential,
  __private: probePrivate
} = require('../lib/cli/services/usage/codebuddy-quota-probe');

function makeOkResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

// 与实机同形：account.uid + auth.accessToken/domain 都在共享凭据文件里。
function writeSharedCredential(aiHomeDir, provider, accountRef, overrides = {}) {
  const relative = resolveCodebuddyFamilyAuthPath(provider);
  if (!relative) return '';
  const credentialPath = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    provider,
    accountRef,
    ...relative
  );
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  const payload = familyCredential(provider, { ...overrides, marker: overrides.accessToken });
  fs.writeFileSync(credentialPath, JSON.stringify(payload), 'utf8');
  return credentialPath;
}

function setupFamilyAccount(provider, options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), `aih-codebuddy-quota-${provider}-`));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: options.cliAccountId || '1',
    identitySeed: `test:${provider}:quota:${options.cliAccountId || '1'}`
  });
  if (options.env) writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
  let credentialPath = '';
  if (options.credential !== false) credentialPath = writeSharedCredential(aiHomeDir, provider, accountRef, options.credential || {});
  return { aiHomeDir, accountRef, credentialPath };
}

function makeSummaryPayload(dataOverrides = {}) {
  return {
    code: 0,
    msg: 'OK',
    data: {
      Packages: [
        {
          PackageCode: 'TCACA_code_007_nzdH5h4Nl0',
          CycleTotalCapacity: '1556',
          CycleRemainCapacity: '1421.74000016',
          CycleUsedCapacity: '134.25999984',
          CycleFrozenCapacity: '0',
          CapacityUnit: 'credits'
        },
        {
          PackageCode: 'TCACA_code_008_cfWoLwvjU4',
          CycleTotalCapacity: '500',
          CycleRemainCapacity: '0',
          CycleUsedCapacity: '500',
          CycleFrozenCapacity: '0',
          CapacityUnit: 'credits'
        }
      ],
      SubscriptionPackageCode: '',
      IsPaidUser: false,
      IsProtectedPriceUser: false,
      ...dataOverrides
    }
  };
}

// --- 1. 静态口径：端点 / 凭据路径 / 商品码 -------------------------------

test('family providers resolve to their real billing endpoint and shared credential file', () => {
  assert.deepEqual(CODEBUDDY_FAMILY_PROVIDERS, ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);
  for (const provider of CODEBUDDY_FAMILY_PROVIDERS) {
    assert.equal(isCodebuddyFamilyProvider(provider), true, provider);
    assert.equal(
      resolveCodebuddyFamilyBillingEndpoint(provider).startsWith('https://'),
      true,
      `${provider} needs an https endpoint`
    );
    assert.ok(Array.isArray(resolveCodebuddyFamilyAuthPath(provider)), `${provider} needs an auth path`);
  }
  // 国内站两支共用一个网关；国际站两支各用自己站点域名。
  assert.equal(resolveCodebuddyFamilyBillingEndpoint('codebuddycn'), 'https://copilot.tencent.com');
  assert.equal(resolveCodebuddyFamilyBillingEndpoint('workbuddycn'), 'https://copilot.tencent.com');
  assert.equal(resolveCodebuddyFamilyBillingEndpoint('codebuddy'), 'https://www.codebuddy.ai');
  assert.equal(resolveCodebuddyFamilyBillingEndpoint('workbuddy'), 'https://www.workbuddy.ai');
  // 国内站两支共用同一份凭据文件（与 storage policy 的 authArtifact 同源）。
  assert.deepEqual(
    resolveCodebuddyFamilyAuthPath('codebuddycn'),
    resolveCodebuddyFamilyAuthPath('workbuddycn')
  );
  assert.equal(isCodebuddyFamilyProvider('zcode'), false);
  assert.equal(resolveCodebuddyFamilyBillingEndpoint('zcode'), '');
});

test('resource summary path is the no-prefix one (the /v2 variant is a 404)', () => {
  // 这条是接口契约的硬约束：老接口 get-user-resource 才需要 /v2。
  assert.equal(CODEBUDDY_RESOURCE_SUMMARY_PATH, '/billing/meter/get-user-resource-summary');
  assert.equal(CODEBUDDY_RESOURCE_SUMMARY_PATH.includes('/v2'), false);
});

test('commodity codes map to stable bucket names and paid plan labels', () => {
  assert.equal(resolveCodebuddyCommodityLabel('TCACA_code_007_nzdH5h4Nl0'), 'activity');
  assert.equal(resolveCodebuddyCommodityLabel('TCACA_code_008_cfWoLwvjU4'), 'freeMon');
  assert.equal(resolveCodebuddyCommodityLabel('TCACA_code_039_KRcQj7wUat'), 'proTrialMon');
  // 未登记的商品码回退成稳定的 code_<NNN>，不带随机尾缀。
  assert.equal(resolveCodebuddyCommodityLabel('TCACA_code_999_aBcDeFgHiJ'), 'code_999');
  assert.equal(resolveCodebuddyCommodityLabel(''), '');
  // 付费档位：试用包刻意不映射（IsPaidUser:false 时展示成 Pro 会误导）。
  assert.equal(resolveCodebuddyPaidPlanLabel('TCACA_code_002_AkiJS3ZHF5'), 'Pro');
  assert.equal(resolveCodebuddyPaidPlanLabel('TCACA_code_027_0FCGVA6vSa'), 'Flagship');
  assert.equal(resolveCodebuddyPaidPlanLabel('TCACA_code_039_KRcQj7wUat'), '');
  assert.equal(resolveCodebuddyPaidPlanLabel(''), '');
});

// --- 2. 解析：聚合条 + 明细条 --------------------------------------------

test('parseCodebuddyResourceSummary emits an authoritative aggregate plus detail rows', () => {
  const capturedAt = 1_789_000_000_000;
  const snapshot = probePrivate.parseCodebuddyResourceSummary(makeSummaryPayload(), capturedAt);

  assert.equal(snapshot.kind, USAGE_SNAPSHOT_KINDS.codebuddy);
  assert.equal(snapshot.source, USAGE_SOURCE_CODEBUDDY);
  assert.equal(snapshot.capturedAt, capturedAt);
  assert.equal(snapshot.entries.length, 3, '1 aggregate + 2 detail');

  const aggregate = snapshot.entries[0];
  assert.equal(aggregate.bucket, 'credits');
  assert.equal(aggregate.totalUnits, 2056);
  assert.equal(aggregate.remainingUnits, 1421.74000016);
  assert.equal(aggregate.usedUnits, 634.25999984);
  assert.equal(aggregate.remainingPct, (1421.74000016 * 100) / 2056);
  assert.equal(aggregate.unitType, 'credits');
  assert.equal(aggregate.category, undefined, 'aggregate must count toward the account minimum');

  const detail = snapshot.entries.slice(1);
  assert.deepEqual(detail.map((entry) => entry.bucket), ['activity', 'freeMon']);
  assert.deepEqual(detail.map((entry) => entry.category), ['detail', 'detail']);
  assert.equal(detail[0].remainingPct, (1421.74000016 * 100) / 1556);
  assert.equal(detail[1].remainingPct, 0);
  // 家族没有 cycle 边界信息，不要臆造重置时间。
  for (const entry of snapshot.entries) {
    assert.equal(entry.windowMinutes, 0);
    assert.equal(entry.window, '');
    assert.equal(entry.resetIn, '');
    assert.equal(entry.resetAtMs, 0);
  }
});

test('an exhausted detail package must not drag the account-level remaining to zero', () => {
  const snapshot = probePrivate.parseCodebuddyResourceSummary(makeSummaryPayload(), 1);
  // sum(remain)/sum(total) ≈ 69.15%，而 freeMon 明细是 0%。
  const accountLevel = getMinRemainingPctFromUsageSnapshot(snapshot);
  assert.ok(accountLevel > 60 && accountLevel < 70, `expected ~69%, got ${accountLevel}`);
  // 明细仍完整保留在 entries 里供展示。
  assert.equal(getUsageRemainingPctValues(snapshot).length, 1, 'only the aggregate counts numerically');
});

test('parseCodebuddyResourceSummary tolerates missing/partial capacity fields', () => {
  const snapshot = probePrivate.parseCodebuddyResourceSummary({
    code: 0,
    data: {
      Packages: [
        { PackageCode: 'TCACA_code_002_AkiJS3ZHF5', CycleTotalCapacity: '100', CycleRemainCapacity: '' },
        { PackageCode: 'TCACA_code_009_0XmEQc2xOf', CycleRemainCapacity: '25' }
      ]
    }
  }, 1);
  assert.ok(snapshot, 'partial packages still produce a snapshot');
  // total=100 / remain 缺失 → 不能算成 100%，回退 total-used，这里两者都缺 → null。
  const totalOnly = snapshot.entries.find((e) => e.bucket === 'proMon');
  assert.equal(totalOnly.remainingPct, null, 'missing remain with zero used is unknown, not 100%');
  // 只有 remain、没有 total → 无法算百分比，但绝对额度要保留。
  const remainOnly = snapshot.entries.find((e) => e.bucket === 'extra');
  assert.equal(remainOnly.remainingPct, null);
  assert.equal(remainOnly.remainingUnits, 25);
});

test('parseCodebuddyResourceSummary rejects payloads with no usable packages', () => {
  assert.equal(probePrivate.parseCodebuddyResourceSummary(null, 1), null);
  assert.equal(probePrivate.parseCodebuddyResourceSummary({ code: 0 }, 1), null);
  assert.equal(probePrivate.parseCodebuddyResourceSummary({ code: 0, data: {} }, 1), null);
  assert.equal(probePrivate.parseCodebuddyResourceSummary({ code: 0, data: { Packages: [] } }, 1), null);
  assert.equal(
    probePrivate.parseCodebuddyResourceSummary({ code: 0, data: { Packages: [{ PackageCode: 'x' }] } }, 1),
    null,
    'packages without any capacity field are not usable'
  );
});

test('planType is only set for real paid plans (trial packages stay unlabelled)', () => {
  const trial = probePrivate.parseCodebuddyResourceSummary(makeSummaryPayload({
    SubscriptionPackageCode: 'TCACA_code_039_KRcQj7wUat',
    IsPaidUser: false
  }), 1);
  assert.equal(trial.account, undefined, 'Pro trial must not be presented as a paid plan');

  const paid = probePrivate.parseCodebuddyResourceSummary(makeSummaryPayload({
    SubscriptionPackageCode: 'TCACA_code_002_AkiJS3ZHF5',
    IsPaidUser: true
  }), 1);
  assert.deepEqual(paid.account, { planType: 'Pro' });
});

// --- 3. 凭据读取 ---------------------------------------------------------

test('readCodebuddySharedCredential reads token/uid/domain from the projection file', () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, {
    credential: { accessToken: 'tok-live', uid: 'uid-live', domain: 'www.workbuddy.cn' }
  });
  const credential = readCodebuddySharedCredential(fs, aiHomeDir, provider, accountRef);
  assert.deepEqual(credential, {
    accessToken: familyCredential(provider, { marker: 'tok-live', uid: 'uid-live', domain: 'www.workbuddy.cn' }).auth.accessToken,
    uid: 'uid-live',
    domain: 'www.workbuddy.cn'
  });
});

test('readCodebuddySharedCredential returns null for a missing or corrupt file', () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, { credential: false });
  assert.equal(readCodebuddySharedCredential(fs, aiHomeDir, provider, accountRef), null);

  const corrupt = setupFamilyAccount(provider);
  fs.writeFileSync(corrupt.credentialPath, '{not json', 'utf8');
  assert.equal(readCodebuddySharedCredential(fs, corrupt.aiHomeDir, provider, corrupt.accountRef), null);

  assert.equal(readCodebuddySharedCredential(fs, aiHomeDir, 'zcode', accountRef), null);
});

// --- 4. 探测端到端（fetch stub） -----------------------------------------

test('probe posts to the CN endpoint with the headers the gateway requires', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, {
    credential: { accessToken: 'tok-cn', uid: 'uid-cn', domain: 'www.workbuddy.cn' }
  });
  const calls = [];
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion: 2,
    readAccountCredentialRecord,
    fetchWithTimeout: async (url, init, timeoutMs, proxyOptions) => {
      calls.push({ url, init, timeoutMs, proxyOptions });
      return makeOkResponse(makeSummaryPayload());
    }
  });
  const result = await probe.probe(accountRef, 4321);
  assert.ok(result.snapshot, `expected snapshot, got ${JSON.stringify(result)}`);
  assert.equal(result.snapshot.schemaVersion, 2);
  assert.equal(result.snapshot.entries[0].bucket, 'credits');
  assert.equal(calls.length, 1);
  // 路径不带 /v2；endpoint 是国内站网关。
  assert.equal(calls[0].url, `https://copilot.tencent.com${CODEBUDDY_RESOURCE_SUMMARY_PATH}`);
  assert.equal(calls[0].timeoutMs, 4321);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{}');
  const headers = calls[0].init.headers;
  assert.equal(headers.Authorization, `Bearer ${familyCredential(provider, { marker: 'tok-cn', uid: 'uid-cn', domain: 'www.workbuddy.cn' }).auth.accessToken}`);
  assert.equal(headers['X-User-Id'], 'uid-cn');
  assert.equal(headers['X-Domain'], 'www.workbuddy.cn');
  assert.equal(headers['User-Agent'], CODEBUDDY_PROBE_USER_AGENT);
  assert.ok(headers['User-Agent'].length > 0, 'CN gateway 403s a script-default UA');
});

test('probe resolves the international endpoint per provider', async () => {
  const provider = 'workbuddy';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, {
    credential: { accessToken: 'tok-intl', uid: 'uid-intl', domain: 'www.workbuddy.ai' }
  });
  let seenUrl = '';
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async (url) => {
      seenUrl = url;
      return makeOkResponse(makeSummaryPayload());
    }
  });
  const result = await probe.probe(accountRef);
  assert.ok(result.snapshot);
  assert.equal(seenUrl, `https://www.workbuddy.ai${CODEBUDDY_RESOURCE_SUMMARY_PATH}`);
});

test('probe is a no-op for api-key accounts', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, { env: { CODEBUDDY_API_KEY: 'sk-abc' } });
  let fetchCalls = 0;
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error('api-key accounts must not enter the quota probe');
    }
  });
  const result = await probe.probe(accountRef);
  assert.equal(result.error, 'api_key_mode_not_applicable');
  assert.equal(fetchCalls, 0);
});

test('probe reports a missing shared credential instead of fetching', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider, { credential: false });
  let fetchCalls = 0;
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      return makeOkResponse(makeSummaryPayload());
    }
  });
  const result = await probe.probe(accountRef);
  assert.equal(result.error, 'missing_shared_credential');
  assert.equal(result.auth, true);
  assert.equal(fetchCalls, 0);
});

test('probe rejects a record belonging to a different provider', async () => {
  const { aiHomeDir, accountRef } = setupFamilyAccount('zcode');
  let fetchCalls = 0;
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch for a non-family provider');
    }
  });
  const result = await probe.probe(accountRef);
  assert.equal(result.error, 'credential_record_missing');
  assert.equal(fetchCalls, 0);
});

test('probe distinguishes CN WAF rejection from invalid OAuth', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse({ code: 10085, msg: '请求不合法' }, 403)
  });
  const result = await probe.probe(accountRef);
  assert.equal(result.error, 'codebuddy_resource_waf_rejected');
  assert.equal(result.auth, false);
});

test('probe surfaces a business error carried on HTTP 200', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse({ code: 14001, msg: 'quota_balance_exhausted' })
  });
  const result = await probe.probe(accountRef);
  assert.match(result.error, /^codebuddy_resource_business_error/);
});

test('probe threads proxy/egress options into the fetch call', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  let fetchProxyOptions = null;
  let egressInput = null;
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'global.example',
    readAccountCredentialRecord,
    async resolveAccountEgressRequestOptions(input) {
      egressInput = input;
      return { ok: true, bound: true, options: { proxyUrl: 'http://127.0.0.1:23102', noProxy: 'localhost' } };
    },
    async fetchWithTimeout(url, init, timeoutMs, proxyOptions) {
      fetchProxyOptions = proxyOptions;
      return makeOkResponse(makeSummaryPayload());
    }
  });
  const result = await probe.probe(accountRef);
  assert.ok(result.snapshot);
  assert.equal(egressInput.provider, 'workbuddycn');
  assert.equal(egressInput.accountRef, accountRef);
  assert.deepEqual(egressInput.options, { proxyUrl: 'http://global-proxy.example:7890', noProxy: 'global.example' });
  assert.deepEqual(fetchProxyOptions, { proxyUrl: 'http://127.0.0.1:23102', noProxy: 'localhost' });
});

test('probe fails closed when egress is unavailable', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  let fetchCalls = 0;
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    async resolveAccountEgressRequestOptions() {
      return { ok: false, error: 'no_egress', egressError: 'blocked' };
    },
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      return makeOkResponse(makeSummaryPayload());
    }
  });
  const result = await probe.probe(accountRef);
  assert.equal(result.error, 'no_egress:blocked');
  assert.equal(fetchCalls, 0);
});

test('probe reports a transport failure without throwing', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      throw new Error('socket hang up');
    }
  });
  const result = await probe.probe(accountRef);
  assert.match(result.error, /^probe_exception:/);
  assert.equal(result.snapshot, undefined);
});

test('probe output survives the trusted-snapshot check used by the cache', async () => {
  const provider = 'workbuddycn';
  const { aiHomeDir, accountRef } = setupFamilyAccount(provider);
  const probe = createCodebuddyQuotaProbe({
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion: 2,
    readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse(makeSummaryPayload())
  });
  const { snapshot } = await probe.probe(accountRef);
  // 与 accounts.js / usage/cache.js 的 trusted 校验条件逐条对齐（漏一条快照会被静默丢弃）。
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.kind, 'codebuddy_credit_balance');
  assert.equal(snapshot.source, USAGE_SOURCE_CODEBUDDY);
  assert.ok(Array.isArray(snapshot.entries));
  assert.ok(Number.isFinite(Number(snapshot.capturedAt)));
});


test('partial packages cannot manufacture an aggregate percentage or a false exhaustion', () => {
  const snapshot = probePrivate.parseCodebuddyResourceSummary({ data: { Packages: [
    { PackageCode: 'a', CycleTotalCapacity: '100', CycleRemainCapacity: '0' },
    { PackageCode: 'b', CycleTotalCapacity: '500' }
  ] } }, 1);
  assert.equal(snapshot.entries[0].remainingPct, null);
  assert.equal(snapshot.entries[0].remainingUnits, null);
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), null);
});

test('complete per-package remain or total-minus-used is summed, not mixed globally', () => {
  const snapshot = probePrivate.parseCodebuddyResourceSummary({ data: { Packages: [
    { PackageCode: 'a', CycleTotalCapacity: '100', CycleRemainCapacity: '20' },
    { PackageCode: 'b', CycleTotalCapacity: '200', CycleUsedCapacity: '50' }
  ] } }, 1);
  assert.equal(snapshot.entries[0].remainingUnits, 170);
  assert.equal(snapshot.entries[0].remainingPct, 17000 / 300);
  assert.equal(snapshot.entries[0].usedUnits, null);
});

test('unreadable or differently denominated packages leave the aggregate unknown', () => {
  for (const extra of [{ PackageCode: 'missing' }, { PackageCode: 'usd', CycleTotalCapacity: '200', CycleRemainCapacity: '200', CapacityUnit: 'USD' }]) {
    const snapshot = probePrivate.parseCodebuddyResourceSummary({ data: { Packages: [
      { PackageCode: 'a', CycleTotalCapacity: '100', CycleRemainCapacity: '0', CapacityUnit: 'credits' }, extra
    ] } }, 1);
    assert.equal(snapshot.entries[0].remainingPct, null);
  }
});

test('capacity parsing rejects booleans, objects, negative and non-finite values', () => {
  for (const value of [true, false, [], {}, -1, '-1', 'Infinity', NaN]) assert.equal(probePrivate.readCapacity(value), null);
  assert.equal(probePrivate.readCapacity('0'), 0);
  assert.equal(probePrivate.readCapacity('1.25'), 1.25);
});

test('a paid-looking product code cannot override IsPaidUser=false or absent', () => {
  for (const IsPaidUser of [false, undefined]) {
    const snapshot = probePrivate.parseCodebuddyResourceSummary(makeSummaryPayload({
      SubscriptionPackageCode: 'TCACA_code_002_AkiJS3ZHF5', IsPaidUser
    }), 1);
    assert.equal(snapshot.account, undefined);
  }
});
