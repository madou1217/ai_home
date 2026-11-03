'use strict';

// 生图 prompt 的已知硬上限在网关这一跳拦住。
//
// 背景（2026-11-02 实测）：给 gpt-image-2 发 180k 字符 prompt，上游 400
// "Invalid 'prompt': string too long. Expected a string with maximum length 32000"。
// 这条请求白打了一次上游（中转账号 5s 往返），还在账号结果里留了一条 invalid_request
// （客户端错误记到账号头上）。因此把「模型已知上限」写进规格：命中就在选号前返回
// 400 prompt_too_long。
//
// 按模型登记而不是按 Provider：同一个 gpt-image-2 既可能走原生 codex，也可能走
// API-key 透传中转（本机实测就是后者）。没登记的模型不猜，仍由上游给权威答案。

const test = require('node:test');
const assert = require('node:assert/strict');

const { getImagePromptLimit } = require('../lib/server/image-generation-model-specs');
const { createCodexImageGenerationStrategy } = require('../lib/server/image-generation-codex');
const { createPassthroughImageGenerationStrategy } = require('../lib/server/image-generation-passthrough');
const { resolveImageCapabilityError } = require('../lib/server/image-generation-executor').__private;

function check(strategy, prompt, model = 'gpt-image-2') {
  return resolveImageCapabilityError(strategy, { mode: 'generation', model, prompt });
}

test('gpt-image-2：超过 32000 字符在网关直接 400', () => {
  const error = check(createCodexImageGenerationStrategy({}), 'a'.repeat(32001));
  assert.ok(error, '超限必须被拦下');
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'prompt_too_long');
  assert.match(error.message, /32000/);
});

test('gpt-image-2：恰好 32000 字符放行', () => {
  assert.equal(check(createCodexImageGenerationStrategy({}), 'a'.repeat(32000)), null);
});

test('透传上游同样按模型上限拦（本机 gpt-image-2 走的就是这条）', () => {
  const error = check(createPassthroughImageGenerationStrategy({}), 'a'.repeat(32001));
  assert.ok(error, '透传路径也必须拦');
  assert.equal(error.code, 'prompt_too_long');
});

test('没登记的模型不猜上限', () => {
  assert.equal(check(createCodexImageGenerationStrategy({}), 'a'.repeat(200000), 'some-other-image-model'), null);
  assert.equal(getImagePromptLimit('some-other-image-model'), 0);
  assert.equal(getImagePromptLimit('GPT-Image-2'), 32000);
});
