const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getOrderedUsageWindows,
  formatUsageWindows,
  formatUsageWindowLines
} = require('../lib/cli/services/usage/window-format');

const claudeCache = {
  kind: 'claude_oauth_usage',
  entries: [
    { window: '7days', windowMinutes: 10080, remainingPct: 52, resetIn: '148h' },
    { window: '5h', windowMinutes: 300, remainingPct: 91, resetIn: '4h 38m' }
  ]
};

test('orders windows shortest-first regardless of input order', () => {
  const windows = getOrderedUsageWindows(claudeCache);
  assert.deepEqual(windows.map((w) => w.window), ['5h', '7days']);
});

test('ls inline format: "5h: 91.0% / 7days: 52.0%"', () => {
  assert.equal(formatUsageWindows(claudeCache), '5h: 91.0% / 7days: 52.0%');
});

test('title compact format: "5h:91% 7days:52%"', () => {
  assert.equal(formatUsageWindows(claudeCache, { compact: true }), '5h:91% 7days:52%');
});

test('usage detail lines carry resets', () => {
  assert.deepEqual(formatUsageWindowLines(claudeCache), [
    '5h: 91.0% (resets in 4h 38m)',
    '7days: 52.0% (resets in 148h)'
  ]);
});

test('universal rule: codex without a 5h window shows only what exists', () => {
  const codex = {
    kind: 'codex_oauth_status',
    entries: [{ window: '7days', windowMinutes: 10080, remainingPct: 80, resetIn: '100h' }]
  };
  assert.equal(formatUsageWindows(codex), '7days: 80.0%');
  assert.equal(formatUsageWindows(codex, { compact: true }), '7days:80%');
});

test('compact/inline views drop windows without a numeric figure', () => {
  const cache = {
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', windowMinutes: 300, remainingPct: 70 },
      { window: 'plan:team x@y.com', windowMinutes: 0, remainingPct: null }
    ]
  };
  assert.equal(formatUsageWindows(cache), '5h: 70.0%');
  // ...but the diagnostic `usage` view keeps the non-numeric fallback row. Ordering is now the
  // shared 额度视图模型规则：有明确窗口长度的在前（短的更前），没有窗口长度的兜底行排在最后
  // （与 kimi 的月度总量排在 5h 之后同一条规则）。
  assert.deepEqual(formatUsageWindowLines(cache), ['5h: 70.0%', 'plan:team x@y.com']);
});

test('non-windowed kinds (gemini/agy) yield nothing here', () => {
  const gemini = { kind: 'gemini_oauth_stats', models: [{ model: 'g', remainingPct: 10 }] };
  assert.equal(formatUsageWindows(gemini), '');
  assert.deepEqual(formatUsageWindowLines(gemini), []);
});
