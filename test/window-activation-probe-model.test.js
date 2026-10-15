'use strict';

// 探测模型解析：模型必须来自目标账号自己的目录，否则网关会在路由层 503 排除该账号
// （2026-10-15 实测：codex 目录已无 gpt-5.4-mini，探测全部 http_503，窗口不推进）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveProbeModel } = require('../lib/server/window-activation/probe-model');
const { getProbeSpec } = require('../lib/server/window-activation/probe-specs');

const CODEX = getProbeSpec('codex');
const AGY = getProbeSpec('agy');

test('首选模型在账号目录里就直接用它', () => {
  assert.deepEqual(
    resolveProbeModel(CODEX, ['gpt-5.4-mini', 'gpt-5.6-sol']),
    { model: 'gpt-5.4-mini', source: 'spec' }
  );
});

test('首选不在目录里时按候选顺序回退（真实场景：目录只剩 gpt-5.6/6 系列）', () => {
  const catalog = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'];
  const resolved = resolveProbeModel(CODEX, catalog);
  assert.equal(resolved.source, 'candidate');
  assert.equal(catalog.includes(resolved.model), true);
});

test('候选一个都不命中时按协议族正则从目录里挑一个（避免上游改名即失效）', () => {
  const resolved = resolveProbeModel(CODEX, ['gpt-9-future', 'o3-other']);
  assert.deepEqual(resolved, { model: 'gpt-9-future', source: 'pattern' });
  // 同族多个时取字典序最小（确定性）
  assert.equal(resolveProbeModel(CODEX, ['gpt-9-zeta', 'gpt-9-alpha']).model, 'gpt-9-alpha');
});

test('目录里没有任何同族模型 → 空模型（调用方跳过探测，绝不发必 503 的请求）', () => {
  assert.deepEqual(resolveProbeModel(CODEX, ['o3-mini']), { model: '', source: 'unavailable' });
  assert.deepEqual(resolveProbeModel(AGY, ['claude-sonnet-4-6']), { model: '', source: 'unavailable' });
});

test('账号目录未知（空集 / null）时退回 spec 默认模型，交给上游给真实错误', () => {
  assert.deepEqual(resolveProbeModel(CODEX, null), { model: 'gpt-5.4-mini', source: 'unknown_catalog' });
  assert.deepEqual(resolveProbeModel(CODEX, new Set()), { model: 'gpt-5.4-mini', source: 'unknown_catalog' });
});

test('agy 目录里命中 gemini 系列即可探测', () => {
  assert.deepEqual(
    resolveProbeModel(AGY, ['claude-opus-4-6-thinking', 'gemini-3-flash', 'gemini-2.5-flash']),
    { model: 'gemini-2.5-flash', source: 'spec' }
  );
  assert.equal(resolveProbeModel(AGY, ['gemini-3.8-flash-tiered']).model, 'gemini-3.8-flash-tiered');
});
