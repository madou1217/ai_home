'use strict';

// kiro「不依赖本地 CLI」的纯 API 采集链路回归。
//
// 背景（2026-10-15 真实事故）：账号页报
//   模型：native_cli_model_discovery_cli_not_found
//   额度：kiro_identity_access_denied
// 两个都不是权限问题：前者是模型清单只有「跑本地 CLI」一条路；后者是 access token 已过期
// （AWS 对过期 SSO token 返回 403，被映射成 access_denied），而刷新以前只能从本地 CLI 的
// sqlite 里抄。本文件守住修复后的两条纯 API 通道与策略链的抉择顺序。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeRegistration,
  resolveKiroDeviceRegistration
} = require('../lib/account/kiro-device-registration');
const { refreshKiroGrant, isKiroAccessTokenFresh } = require('../lib/account/kiro-token-refresh');
const { fetchKiroAvailableModels, collectModelIds } = require('../lib/account/kiro-model-catalog');
const { createKiroHttpModelDiscovery } = require('../lib/account/kiro-model-discovery');
const { runProviderModelStrategies } = require('../lib/server/provider-model-strategies');
const { getProviderCapability } = require('../lib/providers');

const REGISTRATION = {
  client_id: 'client-id-1234567890',
  client_secret: 'client-secret-value',
  client_secret_expires_at: '2027-01-04T11:25:18Z',
  region: 'us-east-1',
  oauth_flow: 'DeviceCode',
  scopes: ['codewhisperer:conversations']
};

/** 造一份真实的 auth_kv sqlite（与 CLI 落盘形态一致），再按导入形态存成 base64。 */
function buildEmbeddedDatabaseBase64(rows) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-kv-'));
  const file = path.join(dir, 'data.sqlite3');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  const insert = database.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(rows)) insert.run(key, JSON.stringify(value));
  database.close();
  const encoded = fs.readFileSync(file).toString('base64');
  fs.rmSync(dir, { recursive: true, force: true });
  return encoded;
}

test('device-registration：显式字段优先，缺失时从内嵌 base64 sqlite 解析', () => {
  const explicit = resolveKiroDeviceRegistration({ registration: REGISTRATION });
  assert.equal(explicit.registration.clientId, 'client-id-1234567890');
  assert.equal(explicit.registration.region, 'us-east-1');

  const embedded = resolveKiroDeviceRegistration({
    database: buildEmbeddedDatabaseBase64({ 'kirocli:odic:device-registration': REGISTRATION })
  });
  assert.equal(embedded.registration.clientId, 'client-id-1234567890');
  assert.equal(embedded.registration.clientSecret, 'client-secret-value');
});

test('device-registration：拿不到时 fail closed 并给出原因（交给 CLI 兜底策略）', () => {
  assert.equal(resolveKiroDeviceRegistration({}).error, 'kiro_registration_unavailable');
  assert.equal(
    resolveKiroDeviceRegistration({ database: buildEmbeddedDatabaseBase64({ other: { a: 1 } }) }).error,
    'kiro_registration_missing'
  );
  assert.equal(normalizeRegistration({ client_id: 'x' }), null);
});

test('纯 API 刷新：OIDC CreateToken 换新 token，refresh_token 未轮换时沿用', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ accessToken: 'aoa-new-token', expiresIn: 3600 }) };
  };
  const grant = await refreshKiroGrant(
    { refreshToken: 'aor-old-refresh', registration: { clientId: 'cid', clientSecret: 'secret', region: 'us-east-1' } },
    { request }
  );
  assert.equal(calls[0].url, 'https://oidc.us-east-1.amazonaws.com/token');
  assert.deepEqual(calls[0].body, {
    clientId: 'cid', clientSecret: 'secret', grantType: 'refresh_token', refreshToken: 'aor-old-refresh'
  });
  assert.equal(grant.accessToken, 'aoa-new-token');
  assert.equal(grant.refreshToken, 'aor-old-refresh');
  assert.ok(grant.expiresAtMs > Date.now());
});

test('纯 API 刷新：非 200 / 缺凭据都要有可辨识的错误码', async () => {
  await assert.rejects(
    () => refreshKiroGrant(
      { refreshToken: 'r', registration: { clientId: 'c', clientSecret: 's' } },
      { request: async () => ({ status: 400, json: async () => ({}) }) }
    ),
    (error) => error.code === 'kiro_refresh_http_400'
  );
  await assert.rejects(
    () => refreshKiroGrant(
      { refreshToken: 'r', registration: { clientId: '', clientSecret: '' } },
      { request: async () => ({ status: 200 }) }
    ),
    (error) => error.code === 'kiro_refresh_missing_client_registration'
  );
});

test('token 新鲜度：过期/临近过期都要判为需要刷新', () => {
  assert.equal(isKiroAccessTokenFresh({ expires_at: new Date(Date.now() + 3600_000).toISOString() }), true);
  assert.equal(isKiroAccessTokenFresh({ expires_at: new Date(Date.now() - 1000).toISOString() }), false);
  // 60s 余量内视为不可用，避免边界上刚好过期。
  assert.equal(isKiroAccessTokenFresh({ expires_at: new Date(Date.now() + 30_000).toISOString() }), false);
  assert.equal(isKiroAccessTokenFresh({}), false);
});


test('模型清单：ListAvailableModels 解析出 models[] 与 defaultModel（去重排序）', async () => {
  const request = async (url, init) => {
    assert.equal(url, 'https://codewhisperer.us-east-1.amazonaws.com/');
    assert.equal(init.headers['x-amz-target'], 'AmazonCodeWhispererService.ListAvailableModels');
    return {
      status: 200,
      text: async () => JSON.stringify({
        defaultModel: { modelId: 'claude-sonnet-4.5' },
        models: [{ modelId: 'claude-sonnet-4' }, { modelId: 'claude-haiku-4.5' }, { modelId: 'claude-sonnet-4.5' }]
      })
    };
  };
  const catalog = await fetchKiroAvailableModels({ access_token: 'tok', region: 'us-east-1' }, { request });
  assert.deepEqual(catalog.models, ['claude-haiku-4.5', 'claude-sonnet-4', 'claude-sonnet-4.5']);
  assert.equal(catalog.defaultModel, 'claude-sonnet-4.5');
  assert.deepEqual(collectModelIds({ models: [{ modelName: 'x' }, {}] }), ['x']);
});

test('模型清单：403/空目录必须报错，不能返回空清单冒充成功', async () => {
  await assert.rejects(
    () => fetchKiroAvailableModels({ access_token: 'tok' }, { request: async () => ({ status: 403, text: async () => '{}' }) }),
    (error) => error.code === 'kiro_models_http_403'
  );
  await assert.rejects(
    () => fetchKiroAvailableModels({ access_token: 'tok' }, { request: async () => ({ status: 200, text: async () => '{"models":[]}' }) }),
    (error) => error.code === 'kiro_models_empty_catalog'
  );
  await assert.rejects(
    () => fetchKiroAvailableModels({}, { request: async () => ({ status: 200, text: async () => '{}' }) }),
    (error) => error.code === 'kiro_models_missing_access_token'
  );
});

test('模型发现纯 API：token 过期先自刷新，再列模型（全程不碰本地 CLI）', async () => {
  const seen = [];
  const record = {
    accountRef: 'acct_test',
    provider: 'kiro',
    nativeAuth: {
      registration: REGISTRATION,
      auth: {
        access_token: 'aoa-expired',
        refresh_token: 'aor-refresh',
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
        region: 'us-east-1'
      }
    }
  };
  const discovery = createKiroHttpModelDiscovery({
    fs,
    aiHomeDir: '/tmp/aih-kiro-model-test',
    readAccountCredentialRecord: () => record,
    ensureFreshKiroGrant: async (current) => {
      seen.push('refresh');
      return {
        record: {
          ...current,
          nativeAuth: { ...current.nativeAuth, auth: { ...current.nativeAuth.auth, access_token: 'aoa-fresh' } }
        }
      };
    },
    fetchKiroAvailableModels: async (auth) => {
      seen.push(`models:${auth.access_token}`);
      return { models: ['claude-sonnet-4.5'], defaultModel: 'claude-sonnet-4.5' };
    }
  });
  const result = await discovery.discover({ provider: 'kiro', accountRef: 'acct_test' }, 5000);
  assert.deepEqual(result.models, ['claude-sonnet-4.5']);
  assert.deepEqual(seen, ['refresh', 'models:aoa-fresh']);
});

test('模型发现纯 API：拿不到凭据记录时报错而不是抛异常', async () => {
  const discovery = createKiroHttpModelDiscovery({
    fs,
    aiHomeDir: '/tmp/aih-kiro-model-test',
    readAccountCredentialRecord: () => null
  });
  assert.equal((await discovery.discover({ provider: 'kiro', accountRef: 'acct_test' }, 5000)).error, 'credential_record_missing');
});

test('模型发现策略链：不依赖客户端的策略优先，失败后按序兜底且 attempts 可观察', async () => {
  // 描述符里 kiro 声明了 [kiro-http-models(不依赖客户端), kiro-native-cli-models(依赖 CLI)]。
  const capability = getProviderCapability('kiro', 'models');
  assert.equal(capability.supported, true);
  assert.deepEqual(capability.strategies.map((strategy) => strategy.id), ['kiro-http-models', 'kiro-native-cli-models']);

  // HTTP 策略失败（拿不到凭据记录）→ 链继续走到 CLI 兜底，两条尝试都记录在 attempts 里。
  const result = await runProviderModelStrategies('kiro', { provider: 'kiro', accountRef: 'acct_missing' }, {
    deps: { fs, aiHomeDir: '/tmp/aih-kiro-model-test', readAccountCredentialRecord: () => null },
    timeoutMs: 1000
  });
  assert.equal(result.models, null);
  assert.deepEqual(result.attempts.map((attempt) => attempt.strategyId), ['kiro-http-models', 'kiro-native-cli-models']);
  assert.equal(result.attempts[0].error, 'credential_record_missing');
  assert.match(result.attempts[1].error, /strategy_factory_invalid/);
});

test('额度策略链：kiro 声明了「纯 API 刷新」与「CLI 兜底」两条，且前者不依赖客户端', () => {
  const quota = getProviderCapability('kiro', 'quota');
  const ids = quota.strategies.map((strategy) => strategy.id);
  assert.deepEqual(ids, ['kiro-http-refresh', 'kiro-cli-capture']);
  assert.equal(quota.strategies[0].clientDependent, false);
  assert.equal(quota.strategies[0].transport, 'http');
  assert.equal(quota.strategies[1].clientDependent, true);
  assert.equal(quota.strategies[1].transport, 'client-cli');
});
