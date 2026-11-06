'use strict';

// 账号级规则推送的契约：只推账号自身规则 + 挂载组 id；已拼装有效规则只作为
// 双写开关下的兼容投影单独推送，不能混在账号级载荷里。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoCoreHost } = require('../lib/server/go-core-host');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const OLD_GO_REF = 'acct_ffffffffffffffffffff';

function rule(name, kind = 'rate_limited') {
  return {
    name,
    kind,
    enabled: true,
    statuses: [429],
    matchers: [{ source: 'body', operator: 'contains', value: name }]
  };
}

function createHost(options = {}) {
  const calls = { put: [], deleted: [], compat: [] };
  let putAttempts = 0;
  const host = createGoCoreHost({
    settings: {
      enabled: false,
      accountSync: false,
      routes: [],
      upstreamRulesCompat: options.compat === true
    },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    aiHomeDir: options.aiHomeDir || '',
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      start: async () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    }),
    accountRuleConfigs: () => options.accounts || [],
    accountPools: () => options.pools || {},
    createGoManagementClient: () => ({
      listAccountUpstreamErrorRules: async () => ({
        ok: true,
        status: 200,
        data: {
          generation: 4,
          supported_providers: ['codex'],
          accounts: options.existingRefs === undefined
            ? [{ account_ref: OLD_GO_REF }]
            : options.existingRefs.map((accountRef) => ({ account_ref: accountRef }))
        }
      }),
      putAccountUpstreamErrorRules: async (accountRef, payload) => {
        calls.put.push({ accountRef, payload });
        putAttempts += 1;
        if (options.failPutOnce && putAttempts === 1) {
          return { ok: false, status: 503, data: null, errorCode: 'unavailable' };
        }
        return { ok: true, status: 200, data: { account_ref: accountRef, supported: true } };
      },
      deleteAccountUpstreamErrorRules: async (accountRef) => {
        calls.deleted.push(accountRef);
        return { ok: true, status: 200, data: { deleted: true } };
      },
      pushUpstreamErrorRules: async (accounts) => {
        calls.compat.push(accounts);
        return {
          ok: true,
          status: 200,
          data: {
            generation: 5,
            accepted_account_refs: accounts.map((account) => account.account_ref),
            dropped: [],
            mismatched_account_refs: [ACCOUNT_REF]
          }
        };
      }
    })
  });
  return { host, calls };
}

test('默认只推账号级规则：不带已拼装的有效规则', async () => {
  const { host, calls } = createHost({
    accounts: [{
      accountRef: ACCOUNT_REF,
      provider: 'codex',
      env: {
        AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]),
        AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify(['uem_second', 'uem_first'])
      }
    }],
    pools: {
      codex: [{
        accountRef: ACCOUNT_REF,
        provider: 'codex',
        upstreamErrorRules: [rule('from-group'), rule('own')]
      }]
    }
  });

  const result = await host.pushUpstreamErrorRules();

  assert.equal(result.ok, true);
  assert.equal(calls.put.length, 1);
  assert.deepEqual(calls.put[0].payload.group_ids, ['uem_second', 'uem_first']);
  assert.deepEqual(calls.put[0].payload.rules.map((item) => item.name), ['own']);
  // 旧引用必须清掉，否则 Node 清空规则后 Go 还会继续执行旧配置。
  assert.deepEqual(calls.deleted, [OLD_GO_REF]);
  // 兼容投影默认不推。
  assert.equal(calls.compat.length, 0);
  assert.equal(host.acceptedUpstreamErrorRuleRefs().has(ACCOUNT_REF), true);
});

test('打开双写开关时才额外推整份有效规则，并记录对拍差异', async () => {
  const { host, calls } = createHost({
    compat: true,
    accounts: [{
      accountRef: ACCOUNT_REF,
      provider: 'codex',
      env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]) }
    }],
    pools: {
      codex: [{
        accountRef: ACCOUNT_REF,
        provider: 'codex',
        upstreamErrorRules: [rule('from-group'), rule('own')]
      }]
    },
    existingRefs: [ACCOUNT_REF]
  });

  await host.pushUpstreamErrorRules();

  assert.equal(calls.put.length, 1);
  assert.equal(calls.compat.length, 1);
  assert.deepEqual(calls.compat[0][0].rules.map((item) => item.name), ['from-group', 'own']);
  const status = host.status();
  assert.deepEqual(status.upstreamErrorRulesCompat.mismatched, [ACCOUNT_REF]);
});

test('瞬时失败不记指纹，下一轮会重试', async () => {
  const accounts = [{
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]) }
  }];
  const { host, calls } = createHost({ accounts, existingRefs: [ACCOUNT_REF], failPutOnce: true });

  const first = await host.pushUpstreamErrorRules();
  assert.equal(first.failed, 1);
  assert.equal(calls.put.length, 1);

  const second = await host.pushUpstreamErrorRules();
  assert.equal(second.failed, 0);
  assert.equal(calls.put.length, 2);
  assert.equal(host.acceptedUpstreamErrorRuleRefs().has(ACCOUNT_REF), true);
});

test('内容未变化时跳过重复推送，force 可以强制重推', async () => {
  const accounts = [{
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]) }
  }];
  const { host, calls } = createHost({ accounts, existingRefs: [ACCOUNT_REF] });

  const first = await host.pushUpstreamErrorRules();
  assert.equal(first.ok, true);
  assert.equal(calls.put.length, 1);

  const second = await host.pushUpstreamErrorRules();
  assert.equal(second.skipped, true);
  assert.equal(calls.put.length, 1);

  await host.pushUpstreamErrorRules({ force: true });
  assert.equal(calls.put.length, 2);
});
