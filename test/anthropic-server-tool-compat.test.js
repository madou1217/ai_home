const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isOfficialAnthropicBaseUrl,
  isOfficialOnlyServerTool,
  stripOfficialOnlyServerTools,
  sanitizeAnthropicBetaHeader
} = require('../lib/server/anthropic-server-tool-compat');

test('isOfficialAnthropicBaseUrl recognizes the official endpoint only', () => {
  assert.equal(isOfficialAnthropicBaseUrl('https://api.anthropic.com/v1'), true);
  assert.equal(isOfficialAnthropicBaseUrl('https://api.anthropic.com'), true);
  assert.equal(isOfficialAnthropicBaseUrl('https://API.Anthropic.com/v1'), true);
  // Third-party Anthropic-compatible endpoints (GLM/Zhipu, DashScope, ...).
  assert.equal(isOfficialAnthropicBaseUrl('https://open.bigmodel.cn/api/anthropic'), false);
  assert.equal(isOfficialAnthropicBaseUrl('https://dashscope.aliyuncs.com/apps/anthropic'), false);
  assert.equal(isOfficialAnthropicBaseUrl(''), false);
  assert.equal(isOfficialAnthropicBaseUrl('not a url'), false);
});

test('isOfficialOnlyServerTool matches the advisor server tool variant', () => {
  assert.equal(isOfficialOnlyServerTool({ type: 'advisor_20260301', name: 'advisor' }), true);
  assert.equal(isOfficialOnlyServerTool({ type: 'advisor' }), true);
  assert.equal(isOfficialOnlyServerTool({ type: 'web_search_20250305', name: 'web_search' }), false);
  assert.equal(isOfficialOnlyServerTool({ type: 'web_search_20260209' }), false);
  assert.equal(isOfficialOnlyServerTool({ name: 'custom_function' }), false);
  assert.equal(isOfficialOnlyServerTool(null), false);
});

test('stripOfficialOnlyServerTools drops advisor but keeps web_search and client tools', () => {
  const tools = [
    { name: 'Bash', input_schema: {} },
    { type: 'web_search_20250305', name: 'web_search' },
    { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-8' },
    { name: 'Read', input_schema: {} }
  ];
  const { tools: kept, removed } = stripOfficialOnlyServerTools(tools);
  assert.deepEqual(removed, ['advisor_20260301']);
  assert.equal(kept.length, 3);
  assert.ok(kept.some((t) => t.type === 'web_search_20250305'));
  assert.ok(!kept.some((t) => t.type === 'advisor_20260301'));
  // Original array is not mutated.
  assert.equal(tools.length, 4);
});

test('stripOfficialOnlyServerTools is a no-op when there is nothing official-only', () => {
  const tools = [{ name: 'Bash' }, { type: 'web_search_20260209', name: 'web_search' }];
  const { tools: kept, removed } = stripOfficialOnlyServerTools(tools);
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 2);
});

test('stripOfficialOnlyServerTools leaves non-array tools untouched', () => {
  assert.deepEqual(stripOfficialOnlyServerTools(undefined), { tools: undefined, removed: [] });
  assert.deepEqual(stripOfficialOnlyServerTools(null), { tools: null, removed: [] });
});

test('sanitizeAnthropicBetaHeader removes advisor-tool token, keeps the rest in order', () => {
  const result = sanitizeAnthropicBetaHeader('oauth-2025-04-20,advisor-tool-2026-03-01,fine-grained-tool-streaming-2025-05-14');
  assert.deepEqual(result.removed, ['advisor-tool-2026-03-01']);
  assert.equal(result.value, 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14');
});

test('sanitizeAnthropicBetaHeader is a no-op when no advisor token is present', () => {
  const result = sanitizeAnthropicBetaHeader('oauth-2025-04-20');
  assert.deepEqual(result.removed, []);
  assert.equal(result.value, 'oauth-2025-04-20');
});

test('sanitizeAnthropicBetaHeader handles an empty header', () => {
  const result = sanitizeAnthropicBetaHeader('');
  assert.deepEqual(result.removed, []);
  assert.equal(result.value, '');
});

test('account-5 regression guard: official base url keeps advisor untouched', () => {
  // Mirrors the gateway gate: only non-official upstreams strip the tool.
  const upstreamBase = 'https://api.anthropic.com/v1';
  const tools = [{ type: 'advisor_20260301', name: 'advisor' }];
  const shouldStrip = !isOfficialAnthropicBaseUrl(upstreamBase);
  assert.equal(shouldStrip, false);
  // When not stripping, tools are forwarded as-is.
  const forwarded = shouldStrip ? stripOfficialOnlyServerTools(tools).tools : tools;
  assert.deepEqual(forwarded, tools);
});
