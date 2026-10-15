'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROBE_SPECS,
  getProbeSpec,
  listProbeProviders
} = require('../lib/server/window-activation/probe-specs');

test('codex 规格形状：/v1/responses + 极小请求体（模型可被目录解析结果替换）', () => {
  const spec = getProbeSpec('codex');
  assert.ok(spec);
  assert.equal(spec.provider, 'codex');
  assert.equal(spec.path, '/v1/responses');
  assert.equal(spec.model, 'gpt-5.4-mini');
  assert.deepEqual(spec.windowMatch, { windowMinutes: 300 });
  const body = spec.body(spec.model);
  assert.equal(body.model, 'gpt-5.4-mini');
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.input.length, 1);
  // 目录解析出的模型必须真的进请求体（否则解析等于没做）。
  assert.equal(spec.body('gpt-5.6-sol').model, 'gpt-5.6-sol');
});

test('agy 规格形状：Gemini 数据面 + 模型进 URL', () => {
  const spec = getProbeSpec('agy');
  assert.ok(spec);
  assert.equal(spec.provider, 'agy');
  assert.equal(typeof spec.path, 'function');
  assert.equal(spec.path('gemini-2.5-flash'), '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(spec.model, 'gemini-2.5-flash');
  assert.equal(spec.probeModelPattern, '^gemini-');
  assert.deepEqual(spec.windowMatch, { windowMinutes: 300 });
  const body = spec.body();
  assert.equal(body.contents.length, 1);
  assert.equal(body.generationConfig.maxOutputTokens, 8);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test('getProbeSpec：大小写与空白归一，未知 provider 返回 null', () => {
  assert.ok(getProbeSpec('CODEX'));
  assert.ok(getProbeSpec(' codex '));
  assert.ok(getProbeSpec('AGY'));
  assert.equal(getProbeSpec('claude'), null);
  assert.equal(getProbeSpec(''), null);
  assert.equal(getProbeSpec(undefined), null);
});

test('getProbeSpec 返回浅拷贝，不暴露可变注册表引用', () => {
  const spec = getProbeSpec('codex');
  spec.path = '/mutated';
  assert.equal(PROBE_SPECS.codex.path, '/v1/responses');
});

test('listProbeProviders 覆盖已注册的 provider（codex / agy）', () => {
  assert.deepEqual(listProbeProviders().sort(), ['agy', 'codex']);
});
