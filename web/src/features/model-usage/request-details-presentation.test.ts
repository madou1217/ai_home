import assert from 'node:assert/strict';
import test from 'node:test';

import * as requestDetailsPresentation from './request-details-presentation.ts';

test('request detail columns expose exactly the requested dimensions', () => {
  const contracts = requestDetailsPresentation.REQUEST_DETAIL_COLUMN_CONTRACTS;

  assert.deepEqual(contracts.usage, [
    { key: 'provider', title: 'Provider' },
    { key: 'model', title: '模型' },
    { key: 'reasoningEffort', title: '推理强度' },
    { key: 'endpoint', title: '端点' },
    { key: 'clientIp', title: 'IP' },
    { key: 'requestType', title: '类型' },
    { key: 'billingMode', title: '计费模式' },
    { key: 'tokens', title: 'Token' },
    { key: 'costUsd', title: '费用' },
    { key: 'durationMs', title: '延迟' },
    { key: 'timestampMs', title: '时间' }
  ]);
  assert.deepEqual(contracts.errors, [
    { key: 'provider', title: 'Provider' },
    { key: 'model', title: '模型' },
    { key: 'reasoningEffort', title: '推理强度' },
    { key: 'endpoint', title: '端点' },
    { key: 'clientIp', title: 'IP' },
    { key: 'requestType', title: '类型' },
    { key: 'statusCode', title: '状态码' },
    { key: 'errorMessage', title: '错误信息' },
    { key: 'durationMs', title: '延迟' },
    { key: 'timestampMs', title: '时间' }
  ]);
  assert.doesNotMatch(JSON.stringify(contracts), /apiKey|accountRef|密钥|分组/);
});

test('request detail values preserve request precision without inventing unavailable latency', () => {
  assert.equal(requestDetailsPresentation.formatRequestDuration(31), '31 ms');
  assert.equal(requestDetailsPresentation.formatRequestDuration(1271), '1.27 s');
  assert.equal(requestDetailsPresentation.formatRequestDuration(0), '-');
  assert.equal(requestDetailsPresentation.formatRequestCost(0.012345), '$0.012345');
  assert.equal(requestDetailsPresentation.formatReasoningEffort('xhigh'), 'XHigh');
  assert.equal(requestDetailsPresentation.formatReasoningEffort('provider_default'), 'Provider 默认');
  assert.equal(requestDetailsPresentation.formatReasoningEffort('not_applicable'), '不适用');
  assert.equal(requestDetailsPresentation.formatReasoningEffort('budget:-1'), '自动预算');
  assert.equal(requestDetailsPresentation.formatReasoningEffort('budget:8000'), '预算 8,000 Tokens');
  assert.equal(requestDetailsPresentation.formatReasoningEffort(''), '历史未记录');
  assert.equal(requestDetailsPresentation.formatRequestType('stream'), '流式');
  assert.equal(requestDetailsPresentation.formatRequestType(''), '历史未记录');
  assert.equal(requestDetailsPresentation.formatRequestProvider('gateway'), 'AIH 网关');
  assert.equal(requestDetailsPresentation.formatRequestProvider('codex'), 'codex');
  assert.equal(requestDetailsPresentation.formatRequestProvider(''), '历史未记录');
  assert.equal(requestDetailsPresentation.formatBillingMode('token'), '按 Token');
  assert.deepEqual(requestDetailsPresentation.buildRequestTokenParts({
    inputTokens: 2000,
    outputTokens: 350,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 20,
    reasoningOutputTokens: 40,
    totalTokens: 2510
  }), [
    { key: 'input', label: '输入', value: 2000 },
    { key: 'output', label: '输出', value: 350 },
    { key: 'cache', label: '缓存', value: 120 },
    { key: 'reasoning', label: '推理', value: 40 },
    { key: 'total', label: '总计', value: 2510 }
  ]);
});
