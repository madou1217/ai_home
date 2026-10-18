'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  SESSION_COUNTER_WRAP,
  mintOpenCodeSessionId,
  __private
} = require('../lib/server/opencode-zen-free-client');

// 上游解码 `ses_` 前缀里的 `~(timestamp * 4096 + counter)`，counter 越界会吃 403
// FreeTierError（门禁拒绝，与 IP 配额无关）。回归目标：counter 永远留在合法值域内。
const { decodeSessionCounter } = __private;

test('minted session ids keep a structurally valid shape', () => {
  const id = mintOpenCodeSessionId();
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test('the counter stays inside the upstream-accepted range across many mints', () => {
  // 远超旧实现 `& 0xfff` 的 4096 值域：旧实现跑满 500 次就会送出非法 counter。
  for (let i = 0; i < 2000; i += 1) {
    const counter = decodeSessionCounter(mintOpenCodeSessionId());
    assert.ok(
      counter >= 0 && counter < SESSION_COUNTER_WRAP,
      `counter ${counter} escaped the valid range [0, ${SESSION_COUNTER_WRAP})`
    );
  }
});

test('the counter never reaches the value observed to be rejected upstream', () => {
  // 实测 counter=500 → 403 FreeTierError；这里确认铸造路径不可能产出该值。
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(decodeSessionCounter(mintOpenCodeSessionId()));
  assert.ok(!seen.has(500));
  assert.ok(Math.max(...seen) < SESSION_COUNTER_WRAP);
});

test('ids minted at the same instant differ only in the counter bits', () => {
  const now = 1_760_000_000_000;
  const a = mintOpenCodeSessionId(now);
  const b = mintOpenCodeSessionId(now);
  const prefixA = BigInt(`0x${a.slice(4, 16)}`);
  const prefixB = BigInt(`0x${b.slice(4, 16)}`);
  // 前缀 48 位 = [时间 36 位][counter 12 位]。同一时刻铸造时时间位必须一致，
  // 只有 counter 位前进 —— 这既是并发不撞的保证，也是上游解码的前提。
  // 注意：毫秒时间戳 * 4096 本身超出 48 位，时间位是被截断的高位，无法完整往返，
  // 所以这里只断言同刻一致，不断言能还原出原始毫秒值。
  assert.equal(prefixA >> 12n, prefixB >> 12n);
  assert.notEqual(prefixA & 0xfffn, prefixB & 0xfffn);
});

// ── 免费端点回退：/inference/v1 优先，额度用完再退回 /zen/v1 ──────────────────
// 2026-10-18 实测：两个端点的免费额度分开计数。/zen/v1 日额度耗尽时（429，
// retry-after 指向下一个 UTC 零点），同一时刻 /inference/v1 直接 200 —— 与出口 IP 无关。

const {
  OPENCODE_FREE_ENDPOINT_URLS,
  OPENCODE_INFERENCE_FREE_URL,
  OPENCODE_ZEN_LEGACY_FREE_URL,
  fetchOpenCodeZenFreeChatCompletionStream
} = require('../lib/server/opencode-zen-free-client');

function fakeFetch(statusByUrl, calls) {
  return async (url) => {
    calls.push(url);
    const status = statusByUrl[url] || 200;
    return { status, ok: status >= 200 && status < 300, text: async () => '', body: { cancel: async () => {} } };
  };
}

const FREE_REQUEST = { model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] };

test('the new /inference/v1 endpoint is tried first', () => {
  assert.equal(OPENCODE_FREE_ENDPOINT_URLS[0], OPENCODE_INFERENCE_FREE_URL);
  assert.equal(OPENCODE_FREE_ENDPOINT_URLS[1], OPENCODE_ZEN_LEGACY_FREE_URL);
});

test('a healthy /inference/v1 is used alone', async () => {
  const calls = [];
  const res = await fetchOpenCodeZenFreeChatCompletionStream({}, { accountRef: 't' }, FREE_REQUEST, 1000,
    { fetchWithTimeout: fakeFetch({}, calls) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [OPENCODE_INFERENCE_FREE_URL]);
});

test('an exhausted /inference/v1 (429) falls back to /zen/v1', async () => {
  const calls = [];
  const res = await fetchOpenCodeZenFreeChatCompletionStream({}, { accountRef: 't' }, FREE_REQUEST, 1000,
    { fetchWithTimeout: fakeFetch({ [OPENCODE_INFERENCE_FREE_URL]: 429 }, calls) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [OPENCODE_INFERENCE_FREE_URL, OPENCODE_ZEN_LEGACY_FREE_URL]);
});

test('a client-gate 403 does not burn the second endpoint', async () => {
  const calls = [];
  await assert.rejects(
    fetchOpenCodeZenFreeChatCompletionStream({}, { accountRef: 't' }, FREE_REQUEST, 1000,
      { fetchWithTimeout: fakeFetch({ [OPENCODE_INFERENCE_FREE_URL]: 403 }, calls) }),
    /HTTP 403/
  );
  // 403 是门禁（请求形状问题），换端点不会好，交给上层的 CLI 兜底通道。
  assert.deepEqual(calls, [OPENCODE_INFERENCE_FREE_URL]);
});

test('both endpoints exhausted surfaces the last 429', async () => {
  const calls = [];
  await assert.rejects(
    fetchOpenCodeZenFreeChatCompletionStream({}, { accountRef: 't' }, FREE_REQUEST, 1000,
      { fetchWithTimeout: fakeFetch({ [OPENCODE_INFERENCE_FREE_URL]: 429, [OPENCODE_ZEN_LEGACY_FREE_URL]: 429 }, calls) }),
    /HTTP 429/
  );
  assert.equal(calls.length, 2);
});

// ── 门禁 ④(a) 的 read 垫片 ─────────────────────────────────────────────────
const {
  ZEN_FREE_GATE_TOOL_NAME,
  buildZenFreeChatPayload,
  ensureZenFreeGateTool
} = require('../lib/server/opencode-zen-free-client');

test('the gate shim is named exactly `read` and carries a non-empty description', () => {
  const tools = ensureZenFreeGateTool(undefined);
  assert.equal(tools.length, 1);
  const [shim] = tools;
  assert.equal(shim.type, 'function');
  // 门禁只认精确名 `read`（大小写敏感）。
  assert.equal(ZEN_FREE_GATE_TOOL_NAME, 'read');
  assert.equal(shim.function.name, 'read');
  // glm 系上游校验 `function.description is required`：空描述直接 400。
  assert.equal(typeof shim.function.description, 'string');
  assert.ok(shim.function.description.trim().length > 0);
  // 措辞必须劝阻调用，参数为空对象：垫片不该诱导模型发起 tool_calls。
  assert.match(shim.function.description, /never call/i);
  assert.deepEqual(shim.function.parameters, { type: 'object', properties: {} });
});

test('the gate shim is appended after caller tools without renaming them', () => {
  const callerTools = [{ type: 'function', function: { name: 'todoread', description: 'x', parameters: {} } }];
  const tools = ensureZenFreeGateTool(callerTools);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0], callerTools[0]);
  assert.equal(tools[1].function.name, 'read');
});

test('requests that already declare `read` are left untouched', () => {
  const callerTools = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } }];
  // 原样返回同一引用：不追加第二个 read（Zen 对重复工具名回 400）。
  assert.strictEqual(ensureZenFreeGateTool(callerTools), callerTools);
  const payload = buildZenFreeChatPayload({ ...FREE_REQUEST, tools: callerTools }, 'deepseek-v4.1-flash-free');
  assert.strictEqual(payload.tools, callerTools);
});

test('the upstream payload always carries the gate shim and streams', () => {
  const payload = buildZenFreeChatPayload(FREE_REQUEST, 'glm-5.3-flash-free');
  assert.equal(payload.stream, true);
  assert.equal(payload.model, 'glm-5.3-flash-free');
  const reads = payload.tools.filter((tool) => tool.function && tool.function.name === 'read');
  assert.equal(reads.length, 1);
  assert.ok(reads[0].function.description.trim());
});
