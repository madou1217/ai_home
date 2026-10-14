'use strict';

// Cline Pass 的对外模型目录与路由判定（2026-10-14 实测）：
// 上游 GET /api/v1/models 返回 462 条 OpenRouter 伙伴命名空间 ID（不含任何 cline-pass/*），
// 原样透出会被 inferProviderFromModel 判给 claude 等 provider；`cline-free/*` 在本网关所用
// 的 API 面上稳定 403。因此目录是静态规范清单，且只有 `cline-pass/` 能回到 cline 上游。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLINE_MODEL_NAMESPACE,
  KNOWN_CLINE_MODELS,
  isClineRoutableModelId,
  isKnownClineModel
} = require('../lib/server/cline-models');
const { inferProviderFromModel } = require('../lib/server/providers');
const { fetchModelsForAccount } = require('../lib/server/http-utils');

// 官方 SDK（@cline/llms）里另有 4 条 cline-free/*，在本网关 API 面上一律 403。
const CLINE_FREE_MODELS = [
  'cline-free/mimo-v2.6-flash',
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/solar-mini4',
  'cline-free/step-5-preview'
];

test('only the cline-pass namespace routes back to the cline upstream', () => {
  assert.equal(CLINE_MODEL_NAMESPACE, 'cline-pass/');

  ['cline-pass/glm-5.3', 'cline-pass/deepseek-v4-pro', 'cline-pass/mimo-v2.5'].forEach((modelId) => {
    assert.equal(isClineRoutableModelId(modelId), true, modelId);
    assert.equal(inferProviderFromModel(modelId), 'cline', modelId);
  });
  // 大小写不敏感（模型 ID 统一小写归一后再判前缀）。
  assert.equal(isClineRoutableModelId('CLINE-PASS/GLM-5.3'), true);
  assert.equal(inferProviderFromModel('CLINE-PASS/GLM-5.3'), 'cline');

  // 裸模型名留给 zcode，`cline/` 与 `cline-free/` 都不算 cline 命名空间。
  ['glm-5.3', 'cline/glm-5.3', 'cline-free/glm-5.3', '', '   ', null, undefined].forEach((modelId) => {
    assert.equal(isClineRoutableModelId(modelId), false, String(modelId));
  });
  assert.equal(inferProviderFromModel('glm-5.3'), 'zcode');
  assert.notEqual(inferProviderFromModel('cline-free/glm-5.2'), 'cline');
});

test('the published cline catalog lists unique cline-pass models and no cline-free', () => {
  assert.ok(KNOWN_CLINE_MODELS.length >= 10, `unexpected catalog size: ${KNOWN_CLINE_MODELS.length}`);
  assert.equal(new Set(KNOWN_CLINE_MODELS).size, KNOWN_CLINE_MODELS.length);

  for (const modelId of KNOWN_CLINE_MODELS) {
    assert.equal(modelId.startsWith(CLINE_MODEL_NAMESPACE), true, modelId);
    assert.equal(modelId, modelId.toLowerCase(), modelId);
    assert.equal(isClineRoutableModelId(modelId), true, modelId);
    assert.equal(isKnownClineModel(modelId), true, modelId);
    assert.equal(inferProviderFromModel(modelId), 'cline', modelId);
  }

  assert.equal(KNOWN_CLINE_MODELS.some((modelId) => modelId.startsWith('cline-free/')), false);
  CLINE_FREE_MODELS.forEach((modelId) => {
    assert.equal(isKnownClineModel(modelId), false, modelId);
  });
  // 未知/裸 ID 不认：目录只放实测可用的 cline-pass 条目。
  assert.equal(isKnownClineModel('cline-pass/not-a-real-model'), false);
  assert.equal(isKnownClineModel('glm-5.3'), false);
  assert.equal(isKnownClineModel(''), false);
  assert.equal(isKnownClineModel(null), false);
});

test('fetchModelsForAccount serves the cline catalog without resolving egress', async () => {
  let egressCalls = 0;
  const options = {
    resolveAccountEgressRequestOptions: async () => {
      egressCalls += 1;
      throw new Error('cline catalog must not resolve account egress');
    }
  };

  const ids = await fetchModelsForAccount(options, { provider: 'cline', accountRef: 'acct_cline_1' });
  assert.deepEqual(ids, KNOWN_CLINE_MODELS.slice());
  assert.equal(egressCalls, 0);

  // provider 大小写归一：'CLINE' 同样短路，不做网络探测。
  const upper = await fetchModelsForAccount(options, { provider: 'CLINE', accountRef: 'acct_cline_1' });
  assert.deepEqual(upper, KNOWN_CLINE_MODELS.slice());
  assert.equal(egressCalls, 0);

  // 返回的是副本：调用方改写结果不得污染规范清单。
  ids.push('cline-pass/injected');
  assert.equal(KNOWN_CLINE_MODELS.includes('cline-pass/injected'), false);
});
