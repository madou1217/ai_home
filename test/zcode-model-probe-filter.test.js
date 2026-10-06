'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fetchZcodePlanBalanceModels,
  fetchZcodePaasModels,
  isZcodeRoutableModelId
} = require('../lib/server/http-utils-zcode');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

test('isZcodeRoutableModelId keeps exactly the ids the gateway routes back to zcode', () => {
  assert.equal(isZcodeRoutableModelId('glm-5.3'), true);
  assert.equal(isZcodeRoutableModelId('GLM-4.5'), true);
  assert.equal(isZcodeRoutableModelId('zcode-start'), true);
  assert.equal(isZcodeRoutableModelId('opencode-go/glm-5.3'), false, 'opencode 命名空间会被网关路由到 opencode');
  assert.equal(isZcodeRoutableModelId('cline-free/glm-5.2'), false, '未知前缀不会路由回 zcode');
  assert.equal(isZcodeRoutableModelId(''), false);
});

test('fetchZcodePlanBalanceModels drops partner-namespace capabilities', async () => {
  const fetchWithTimeout = async (url, init) => {
    assert.match(String(init.headers.authorization), /^Bearer jwt-/);
    return jsonResponse({
      code: 0,
      success: true,
      data: {
        plans: [{ name: 'p' }],
        balances: [
          { show_name: 'GLM-5.3', capabilities: ['model:glm-5.3'] },
          { show_name: 'Partner A', capabilities: ['model:opencode-go/glm-5.3'] },
          { show_name: 'cline-free/glm-5.2', capabilities: [] },
          { show_name: 'GLM-4.7', capabilities: ['model:glm-4.7', 'model:opencode-go/glm-4.7'] }
        ]
      }
    });
  };

  const models = await fetchZcodePlanBalanceModels(
    { fetchWithTimeout },
    { zcodeJwtToken: 'jwt-token' },
    1000
  );
  assert.deepEqual(models, ['glm-5.3', 'glm-4.7'], '伙伴命名空间（opencode-go/*、cline-free/*）不得进入模型清单');
});

test('fetchZcodePaasModels filters the coding catalog to zcode-routable ids', async () => {
  const fetchWithTimeout = async () => jsonResponse({
    data: [
      { id: 'glm-4.5' },
      { id: 'opencode-go/glm-5.3' },
      { id: 'opencode/glm-5.1' },
      { id: 'cline-free/glm-5.2' },
      { id: 'glm-5.2' },
      { id: '' }
    ]
  });

  const models = await fetchZcodePaasModels(
    { fetchWithTimeout },
    { accessToken: 'zai-token' },
    1000
  );
  assert.deepEqual(models, ['glm-4.5', 'glm-5.2']);
});

test('fetchZcodePlanBalanceModels still returns an empty list when the plan has no zcode models', async () => {
  const fetchWithTimeout = async () => jsonResponse({
    code: 0,
    data: { plans: [], balances: [{ show_name: 'cline-free/glm-5.2', capabilities: ['model:cline-free/glm-5.2'] }] }
  });
  const models = await fetchZcodePlanBalanceModels({ fetchWithTimeout }, { zcodeJwtToken: 'jwt-token' }, 1000);
  assert.deepEqual(models, [], '全被过滤仍是有效的空结果，不回退 paas（原语义保留）');
});

test('fetchZcodePlanBalanceModels uses the account telemetry device mid and desktop app version', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-model-metadata-'));
  const accountRef = 'acct_01000000000000000004';
  const telemetryDir = path.join(aiHomeDir, 'run', 'auth-projections', 'zcode', accountRef, '.zcode', 'v2');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'mid-model-probe' }));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  let seenUrl = '';
  let seenHeaders = null;
  const models = await fetchZcodePlanBalanceModels({
    fs,
    aiHomeDir,
    appVersion: '3.14.4',
    fetchWithTimeout: async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return jsonResponse({ code: 0, data: { balances: [{ capabilities: ['model:glm-5.3'] }] } });
    }
  }, { accountRef, zcodeJwtToken: 'jwt-model' }, 1000);

  assert.deepEqual(models, ['glm-5.3']);
  assert.equal(seenUrl, 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.4');
  assert.equal(seenHeaders.authorization, 'Bearer jwt-model');
  assert.equal(seenHeaders['X-Device-Mid'], 'mid-model-probe');
  assert.equal(seenHeaders['X-ZCode-App-Version'], '3.14.4');
});

test('fetchZcodePaasModels surfaces business codes carried without success field', async () => {
  // {code:1005,msg} 不带 success：旧实现只查 success，业务码被丢成「缺 data」。
  const fetchWithTimeout = async () => jsonResponse({ code: 1005, msg: 'exceed quota limit' });
  await assert.rejects(
    fetchZcodePaasModels({ fetchWithTimeout }, { accessToken: 'zai-token' }, 1000),
    /models_business_error: 1005 exceed quota limit/
  );
});

test('fetchZcodePaasModels keeps the plain data shape and missing-data fallback', async () => {
  const fetchWithTimeout = async () => jsonResponse({ data: [{ id: 'glm-5.3' }] });
  const models = await fetchZcodePaasModels({ fetchWithTimeout }, { accessToken: 'zai-token' }, 1000);
  assert.deepEqual(models, ['glm-5.3'], '无 code/success 的裸 data 信封仍是成功');

  const noData = async () => jsonResponse({ data: null });
  await assert.rejects(
    Promise.resolve().then(() => fetchZcodePaasModels({ fetchWithTimeout: noData }, { accessToken: 'zai-token' }, 1000)),
    /models_response_missing_data/
  );
});
