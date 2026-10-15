'use strict';

// 展示覆盖守卫：**每个声明了额度的 provider，按其声明的 entryShape 都必须能渲染**。
//
// 这是「面面俱到」的防回归闸门：新增 provider / 新增条目形态时，只要展示层没跟上，
// 这里就红 —— 而不是等用户看到账号页少了一行或 CLI 少了标签。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listQuotaAnswers,
  listQuotaEntryShapes,
  buildQuotaView,
  resolveEntryShapeByKind,
  formatQuotaViewInline,
  formatQuotaViewLines
} = require('../lib/usage/quota');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

// 每个形态的最小合法快照（字段名取自各 provider 探针的真实产物）。
function syntheticSnapshot(shape, kind) {
  if (shape === 'models') {
    return { kind, capturedAt: 1, models: [{ model: 'sample-model', remainingPct: 42, resetIn: '1h' }] };
  }
  if (shape === 'window') {
    return {
      kind,
      capturedAt: 1,
      entries: [{ bucket: 'rolling_300m', window: '5h', windowMinutes: 300, remainingPct: 42, resetIn: '1h' }]
    };
  }
  return {
    kind,
    capturedAt: 1,
    entries: [{ bucket: 'credits', remainingPct: 42, totalUnits: 100, remainingUnits: 42, unitType: 'credits' }]
  };
}

test('每个声明额度的 provider 都能渲染出 scope 与行内摘要', () => {
  const providers = listQuotaAnswers().filter((answer) => answer.supported);
  assert.ok(providers.length >= 10, `有额度的 provider 数异常：${providers.length}`);
  for (const provider of providers) {
    assert.ok(provider.entryShape, `${provider.provider} 声明了额度却没声明 entryShape`);
    const view = buildQuotaView(syntheticSnapshot(provider.entryShape, provider.kind));
    assert.equal(view.shape, provider.entryShape, `${provider.provider} 形态解析错误`);
    assert.equal(view.unrenderable, '', `${provider.provider} 的快照渲染不出来：${view.unrenderable}`);
    assert.ok(view.scopes.length > 0, `${provider.provider} 没有渲染出任何 scope`);
    assert.ok(view.scopes.every((scope) => scope.label), `${provider.provider} 有 scope 缺标签`);
    assert.notEqual(formatQuotaViewInline(view), '', `${provider.provider} 行内摘要为空`);
    assert.ok(formatQuotaViewLines(view).length > 0, `${provider.provider} 明细行为空`);
  }
});

test('kind 反查覆盖所有已声明 kind（展示层不需要第二份 kind 名单）', () => {
  for (const answer of listQuotaAnswers()) {
    if (!answer.supported) continue;
    assert.equal(resolveEntryShapeByKind(answer.kind), answer.entryShape, `${answer.kind} 反查失败`);
  }
});

test('在用的 entryShape 都在展示层的处理表里', () => {
  const handled = new Set(['window', 'bucket', 'models']);
  for (const shape of listQuotaEntryShapes()) {
    assert.ok(handled.has(shape), `形态 ${shape} 没有渲染实现（会静默不显示）`);
  }
});

test('服务端账号 payload 对每种形态都产出条目与标签', () => {
  for (const answer of listQuotaAnswers()) {
    if (!answer.supported) continue;
    const payload = normalizeAccountUsageSnapshot(syntheticSnapshot(answer.entryShape, answer.kind));
    assert.ok(payload, `${answer.provider} 的快照没有产出账号 payload`);
    assert.equal(payload.entryShape, answer.entryShape);
    const rows = answer.entryShape === 'models' ? payload.models : payload.entries;
    assert.ok(Array.isArray(rows) && rows.length > 0, `${answer.provider} 的 payload 没有条目`);
    assert.ok(rows.every((row) => row.label), `${answer.provider} 的 payload 条目缺 label`);
  }
});

test('未声明的 kind 不进账号 payload（历史行为）', () => {
  assert.equal(normalizeAccountUsageSnapshot({ kind: 'totally_unknown', capturedAt: 1, entries: [] }), null);
});
