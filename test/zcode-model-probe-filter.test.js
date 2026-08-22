'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
