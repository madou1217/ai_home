'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROBE_SPECS,
  getProbeSpec,
  listProbeProviders
} = require('../lib/server/window-activation/probe-specs');

test('codex 规格形状：/v1/responses + 极小请求体', () => {
  const spec = getProbeSpec('codex');
  assert.ok(spec);
  assert.equal(spec.provider, 'codex');
  assert.equal(spec.path, '/v1/responses');
  assert.equal(spec.model, 'gpt-5.4-mini');
  assert.deepEqual(spec.windowMatch, { windowMinutes: 300 });
  const body = spec.body();
  assert.equal(body.model, 'gpt-5.4-mini');
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.input.length, 1);
});

test('getProbeSpec：大小写与空白归一，未知 provider 返回 null', () => {
  assert.ok(getProbeSpec('CODEX'));
  assert.ok(getProbeSpec(' codex '));
  assert.equal(getProbeSpec('claude'), null);
  assert.equal(getProbeSpec(''), null);
  assert.equal(getProbeSpec(undefined), null);
});

test('getProbeSpec 返回浅拷贝，不暴露可变注册表引用', () => {
  const spec = getProbeSpec('codex');
  spec.path = '/mutated';
  assert.equal(PROBE_SPECS.codex.path, '/v1/responses');
});

test('listProbeProviders 当前仅 codex', () => {
  assert.deepEqual(listProbeProviders(), ['codex']);
});
