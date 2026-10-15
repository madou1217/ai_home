'use strict';

// CodeBuddy / WorkBuddy 家族的模型目录 HTTP 通道（不依赖本机客户端）。
//
// 事故背景（2026-10-15）：家族原先只有「解析桌面发行版 App 内嵌运行时 --help」一条路，
// 没装 App 的机器上模型目录永远为空，账号在页面上/路由里都表现为「没有可用的模型」。
// 云端 /v3/config 的 cli agent 清单与 --help 同源，这条通道只认账号登录态。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEBUDDY_FAMILY_CONFIG_PATH,
  parseCodebuddyFamilyConfigModels,
  readCodebuddyFamilyAccessToken,
  fetchCodebuddyFamilyConfigModels,
  createCodebuddyFamilyHttpModelDiscovery
} = require('../lib/account/codebuddy-family-model-discovery');
const { listModelDiscoveryStrategies } = require('../lib/server/model-discovery');

const FAMILY_PROVIDERS = ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'];

// 真实响应形状（2026-10-15 对本机账号实测，截取结构、保留字段名）。
const REAL_CONFIG = {
  code: 0,
  msg: 'OK',
  data: {
    enterpriseId: '',
    agents: [
      { name: 'cli', commands: ['init'], modelTags: ['craft'], models: ['default-model', 'fast-model', 'deepseek-v4.1-flash'] },
      { name: 'contentAnalyzer', models: ['lite'] },
      { name: 'general-purpose', models: null }
    ],
    models: [
      { id: 'default-model', name: 'Auto' },
      { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash SG' }
    ]
  }
};

test('取 cli agent 的模型清单（与 --help 的 Currently supported 同源）', () => {
  assert.deepEqual(parseCodebuddyFamilyConfigModels(REAL_CONFIG), [
    'default-model', 'fast-model', 'deepseek-v4.1-flash'
  ]);
});

test('cli agent 清单缺席时回退到站点模型全集，结构不认时返回 null 而不是空清单', () => {
  const withoutAgent = { data: { agents: [{ name: 'general-purpose', models: null }], models: REAL_CONFIG.data.models } };
  assert.deepEqual(parseCodebuddyFamilyConfigModels(withoutAgent), ['default-model', 'deepseek-v4.1-flash-sg']);
  assert.equal(parseCodebuddyFamilyConfigModels({ data: {} }), null, '空结构必须是 null（要能继续走 CLI 兜底）');
  assert.equal(parseCodebuddyFamilyConfigModels(null), null);
  assert.equal(parseCodebuddyFamilyConfigModels({ data: { agents: [], models: [] } }), null);
});

test('剔除 custom-local 宿主本机模型与重复项（与 CLI 解析同一规则）', () => {
  const payload = {
    data: { agents: [{ name: 'cli', models: ['auto', 'auto', 'custom-local:gpt-6-astra', ' ', 'glm-5.3'] }] }
  };
  assert.deepEqual(parseCodebuddyFamilyConfigModels(payload), ['auto', 'glm-5.3']);
});

test('从原生凭据读 access token（兼容 access_token 写法）', () => {
  assert.equal(readCodebuddyFamilyAccessToken({ credentials: { auth: { accessToken: ' abc ' } } }), 'abc');
  assert.equal(readCodebuddyFamilyAccessToken({ credentials: { auth: { access_token: 'xyz' } } }), 'xyz');
  assert.equal(readCodebuddyFamilyAccessToken({ credentials: {} }), '');
  assert.equal(readCodebuddyFamilyAccessToken(null), '');
});

for (const [provider, base] of [
  ['workbuddy', 'https://www.workbuddy.ai'],
  ['codebuddycn', 'https://copilot.tencent.com'],
  ['workbuddycn', 'https://copilot.tencent.com'],
  ['codebuddy', 'https://www.codebuddy.ai']
]) {
  test(`${provider}: GET ${base}${CODEBUDDY_FAMILY_CONFIG_PATH}（带账号凭据与真实客户端身份头）`, async () => {
    const calls = [];
    const result = await fetchCodebuddyFamilyConfigModels(provider, 'tok-123', {
      request: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => REAL_CONFIG };
      }
    });
    assert.deepEqual(result.models, ['default-model', 'fast-model', 'deepseek-v4.1-flash']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${base}${CODEBUDDY_FAMILY_CONFIG_PATH}`);
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok-123');
    // 站点 WAF 会按 UA 拦脚本请求，身份头必须与推理通道同源。
    assert.equal(calls[0].init.headers['user-agent'], 'CLI/2.63.2 CodeBuddy/2.63.2');
    assert.equal(calls[0].init.headers.origin, base);
  });
}

test('非家族 provider / 缺 token / 上游报错都必须给出可观察的 error，而不是空清单', async () => {
  assert.equal((await fetchCodebuddyFamilyConfigModels('openai', 'tok', { request: async () => ({ ok: true }) })).error,
    'codebuddy_family_model_catalog_unknown_provider');
  assert.equal((await fetchCodebuddyFamilyConfigModels('workbuddy', '', { request: async () => ({ ok: true }) })).error,
    'codebuddy_family_model_catalog_missing_token');
  assert.equal((await fetchCodebuddyFamilyConfigModels('workbuddy', 'tok', {
    request: async () => ({ ok: false, status: 403, json: async () => ({}) })
  })).error, 'codebuddy_family_model_catalog_http_403');
  assert.equal((await fetchCodebuddyFamilyConfigModels('workbuddy', 'tok', {
    request: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })
  })).error, 'codebuddy_family_model_catalog_empty');
});

test('策略实现自己读凭据库（发现账号池里的对象不含 accessToken），并透传组合根注入的 egress fetch', async () => {
  const fetched = [];
  // 组合根（lib/server/http-utils.js）注入的是已绑定账号 egress 的 egressFetchWithTimeout。
  const egressFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const discovery = createCodebuddyFamilyHttpModelDiscovery({
    fs: {},
    aiHomeDir: '/tmp/aih',
    egressFetchWithTimeout: egressFetch,
    readAccountCredentialRecord: (fs, aiHomeDir, accountRef) => {
      assert.equal(accountRef, 'acct_0123456789abcdef0123');
      return {
        provider: 'workbuddy',
        nativeAuth: { credentials: { auth: { accessToken: 'from-db' } } }
      };
    },
    fetchCodebuddyFamilyConfigModels: async (provider, token, options) => {
      fetched.push({ provider, token, request: options.request });
      return { models: ['deepseek-v4.1-flash'] };
    }
  });
  const result = await discovery.discover({ provider: 'workbuddy', accountRef: 'acct_0123456789abcdef0123' });
  assert.deepEqual(result, { models: ['deepseek-v4.1-flash'] });
  assert.deepEqual(fetched, [{ provider: 'workbuddy', token: 'from-db', request: egressFetch }]);
});

test('凭据缺失 / provider 不一致 / 无 token 时给出可观察 error（策略链继续走 CLI 兜底）', async () => {
  const account = { provider: 'workbuddy', accountRef: 'acct_0123456789abcdef0123' };
  const withRecord = (record) => createCodebuddyFamilyHttpModelDiscovery({
    readAccountCredentialRecord: () => record,
    fetchCodebuddyFamilyConfigModels: async () => ({ models: ['unused'] })
  });
  assert.deepEqual(await withRecord(null).discover(account), { error: 'credential_record_missing' });
  assert.deepEqual(
    await withRecord({ provider: 'codebuddy', nativeAuth: { credentials: { auth: { accessToken: 't' } } } }).discover(account),
    { error: 'credential_record_missing' }
  );
  assert.deepEqual(
    await withRecord({ provider: 'workbuddy', nativeAuth: { credentials: { auth: {} } } }).discover(account),
    { error: 'codebuddy_family_model_catalog_credential_unsupported' }
  );
  assert.deepEqual(
    await createCodebuddyFamilyHttpModelDiscovery({ readAccountCredentialRecord: () => { throw new Error('db_down'); } })
      .discover(account),
    { error: 'credential_record_unreadable' }
  );
});

for (const provider of FAMILY_PROVIDERS) {
  test(`${provider}: 描述符声明了 HTTP 策略且排在最前（不再靠本机 App/CLI 才能拿目录）`, () => {
    const strategies = listModelDiscoveryStrategies(provider);
    assert.ok(strategies.length >= 2, `${provider} 应有 HTTP + CLI 两条策略`);
    assert.equal(strategies[0].transport, 'http');
    assert.equal(strategies[0].clientDependent, false);
    assert.deepEqual(strategies[0].modes, ['login']);
    assert.equal(typeof strategies[0].discover, 'function');
    assert.equal(strategies[1].transport, 'cli');
    assert.equal(strategies[1].clientDependent, true);
  });
}
