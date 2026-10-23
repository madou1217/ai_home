'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  listAccountOverrides,
  readOverrides,
  resolveContextWindow,
  sanitizeOverrides,
  setContextOverride,
  setContextOverridesForAccounts
} = require('../lib/server/model-context-overrides');
const {
  buildContextExceededError,
  checkContextBudget,
  estimateInputTokens
} = require('../lib/server/context-budget-guard');

// 用户要求（2026-10-23）：模型上下文窗口按「账号 × 模型」管理 —— 同一 provider 下
// 中转 / OAuth / API Key 账号的真实窗口不同；能自��获取就自动获取，拿不到就手设，
// 且值必须有可靠数据支撑（不能凭感觉写死���。

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { fs, aiHomeDir: root };
}

test('an override is stored per account and per model', (t) => {
  const deps = fixture(t);
  assert.deepEqual(readOverrides(deps), {});
  const result = setContextOverride(deps, { accountRef: 'acct_a', model: 'opencode/x', tokens: 262144 });
  assert.equal(result.ok, true);
  // 另一个账号不受影响 —— 这正是「按账号」的意义。
  assert.deepEqual(listAccountOverrides(deps, 'acct_b'), {});
  assert.deepEqual(listAccountOverrides(deps, 'acct_a'), { 'opencode/x': 262144 });
});

test('resolution prefers the manual override over probe and catalog', (t) => {
  const deps = fixture(t);
  setContextOverride(deps, { accountRef: 'acct_a', model: 'gpt-6-luna', tokens: 123456 });
  const resolved = resolveContextWindow(deps, { accountRef: 'acct_a', model: 'gpt-6-luna', provider: 'opencode' });
  assert.deepEqual(resolved, { tokens: 123456, source: 'override' });
  // 没有覆盖的账号回落到目录值，来源如实标注。
  const catalog = resolveContextWindow(deps, { accountRef: 'acct_other', model: 'gpt-6-luna', provider: 'opencode' });
  assert.equal(catalog.source, 'catalog');
  assert.ok(catalog.tokens > 0);
  // 完全查不到的模型如实报 unknown，不猜。
  assert.deepEqual(resolveContextWindow(deps, { accountRef: 'acct_a', model: 'nope-xyz', provider: 'opencode' }),
    { tokens: 0, source: 'unknown' });
});

test('clearing an override falls back instead of pinning a bogus value', (t) => {
  const deps = fixture(t);
  setContextOverride(deps, { accountRef: 'acct_a', model: 'opencode/x', tokens: 262144 });
  const cleared = setContextOverride(deps, { accountRef: 'acct_a', model: 'opencode/x', tokens: 0 });
  assert.equal(cleared.ok, true);
  assert.deepEqual(readOverrides(deps), {});
});

test('out-of-range values are rejected rather than stored', (t) => {
  const deps = fixture(t);
  for (const tokens of [1, MIN_CONTEXT_TOKENS - 1, MAX_CONTEXT_TOKENS + 1, -5, 'abc', 1.5]) {
    const result = setContextOverride(deps, { accountRef: 'acct_a', model: 'x', tokens });
    assert.equal(result.ok, false, `${tokens} must be rejected`);
    assert.equal(result.error, 'context_tokens_out_of_range');
  }
  assert.deepEqual(readOverrides(deps), {});
});

test('bulk set applies one model window to many accounts atomically', (t) => {
  const deps = fixture(t);
  const result = setContextOverridesForAccounts(deps, {
    accountRefs: ['acct_a', 'acct_b', 'acct_a'],
    model: 'opencode/x',
    tokens: 200000
  });
  assert.equal(result.ok, true);
  const stored = readOverrides(deps);
  assert.deepEqual(Object.keys(stored).sort(), ['acct_a', 'acct_b']);
  assert.equal(stored.acct_a['opencode/x'], 200000);
  // 清空同样批量生效。
  setContextOverridesForAccounts(deps, { accountRefs: ['acct_a', 'acct_b'], model: 'opencode/x', tokens: 0 });
  assert.deepEqual(readOverrides(deps), {});
});

test('sanitize drops malformed entries instead of trusting stored JSON', () => {
  assert.deepEqual(sanitizeOverrides({
    acct_a: { good: 200000, bad: 'x', tiny: 1, huge: 9e9 },
    acct_b: 'not-an-object',
    '': { x: 200000 }
  }), { acct_a: { good: 200000 } });
});

// —— 发送前预检（B）——
// 实测校准数据：opencode/deepseek-v4.1-flash-free，1,113,365 字符 → 225,353 tokens。

test('the estimator is conservative against the measured real request', () => {
  const chars = 1_113_365;
  const estimated = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(chars) }] });
  const measured = 225_353;
  // 必须**高估**：低估��让超限请求漏过去，高估只是让临界请求提前被拦。
  assert.ok(estimated >= measured, `estimated ${estimated} must not undershoot measured ${measured}`);
  assert.ok(estimated <= measured * 1.6, `estimated ${estimated} is unreasonably high`);
});

test('a request over the window is caught before it is sent', () => {
  // 实测被拒的量级（约 450k tokens / 1.4M 字符）。
  const requestJson = { messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] };
  const over = checkContextBudget({ windowTokens: 200000, source: 'catalog', requestJson });
  assert.equal(over.exceeded, true);
  assert.equal(over.windowTokens, 200000);
  // 同一个请求在 1M 窗口下放行 —— 窗口值决定结论，不是写死的阈值。
  assert.equal(checkContextBudget({ windowTokens: 1_000_000, requestJson }).exceeded, false);
});

// 预检不得误杀实测能通过的请求 —— 「宁可放行也不误杀」的可执行版本。
// 实测：deepseek-v4.1-flash-free 声明 200k，1,113,365 字符（225,353 tokens）实测通过。
test('a request the upstream actually accepts is not blocked', () => {
  const requestJson = { messages: [{ role: 'user', content: 'x'.repeat(1_113_365) }] };
  assert.equal(checkContextBudget({ windowTokens: 200000, source: 'catalog', requestJson }).exceeded, false);
});


test('an unknown window never blocks a request', () => {
  // 窗口未知时凭一个猜的值拦截，比放行更危险 —— 交给上游裁决。
  const requestJson = { messages: [{ role: 'user', content: 'x'.repeat(10_000_000) }] };
  assert.equal(checkContextBudget({ windowTokens: 0, requestJson }).exceeded, false);
  assert.equal(checkContextBudget({ requestJson }).exceeded, false);
});

test('the error names the window and where it came from', () => {
  const requestJson = { messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] };
  const check = checkContextBudget({ windowTokens: 200000, source: 'override', requestJson });
  const body = buildContextExceededError(check);
  assert.equal(body.error.code, 'context_length_exceeded');
  assert.equal(body.error.type, 'invalid_request_error');
  // 用户要求值必须有数据支撑：报错要能看出这个窗口从哪来，才知道该不该去 WebUI 改。
  assert.match(body.error.message, /manual override/);
  assert.match(body.error.message, /200000/);
});
