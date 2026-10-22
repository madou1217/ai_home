const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAgyQuotaGroupKey,
  groupAgyQuotaModels,
  formatAgyGroupInline,
  formatAgyQuotaGroups
} = require('../lib/usage/quota/agy-groups');
const { createUsagePresenterService } = require('../lib/cli/services/usage/presenter');

test('resolveAgyQuotaGroupKey maps model IDs and display names to groups', () => {
  // Claude models
  assert.equal(resolveAgyQuotaGroupKey('claude-opus-4-6-thinking'), 'claude_gpt');
  assert.equal(resolveAgyQuotaGroupKey('claude-sonnet-4-6'), 'claude_gpt');
  assert.equal(resolveAgyQuotaGroupKey('claude-3-7-sonnet'), 'claude_gpt');

  // GPT models
  assert.equal(resolveAgyQuotaGroupKey('gpt-oss-120b-medium'), 'claude_gpt');
  assert.equal(resolveAgyQuotaGroupKey('gpt-4o'), 'claude_gpt');

  // Gemini models
  assert.equal(resolveAgyQuotaGroupKey('gemini-2.5-flash'), 'gemini');
  assert.equal(resolveAgyQuotaGroupKey('gemini-2.5-pro'), 'gemini');
  assert.equal(resolveAgyQuotaGroupKey('gemini-3-flash'), 'gemini');
  assert.equal(resolveAgyQuotaGroupKey('gemini-3.8-flash-high'), 'gemini');

  // Display names fallback
  assert.equal(resolveAgyQuotaGroupKey('custom-1', 'Claude 3.7'), 'claude_gpt');
  assert.equal(resolveAgyQuotaGroupKey('custom-2', 'Gemini Flash'), 'gemini');
  assert.equal(resolveAgyQuotaGroupKey('custom-3', 'GPT OSS'), 'claude_gpt');

  // Other models
  assert.equal(resolveAgyQuotaGroupKey('unknown-model'), 'other');
  assert.equal(resolveAgyQuotaGroupKey(''), 'other');
  assert.equal(resolveAgyQuotaGroupKey(null), 'other');
});

test('groupAgyQuotaModels aggregates and clamps percentages', () => {
  const models = [
    { model: 'claude-opus-4-6-thinking', remainingPct: 95.6, resetIn: '3h 59m', resetAtMs: 2000 },
    { model: 'claude-sonnet-4-6', remainingPct: 95.6, resetIn: '3h 59m', resetAtMs: 2000 },
    { model: 'gpt-oss-120b-medium', remainingPct: 95.6, resetIn: '3h 59m', resetAtMs: 2000 },
    { model: 'gemini-2.5-flash', remainingPct: 100.0, resetIn: '5h', resetAtMs: 5000 },
    { model: 'gemini-2.5-pro', remainingPct: 100.0, resetIn: '5h', resetAtMs: 5000 }
  ];

  const groups = groupAgyQuotaModels(models);
  assert.equal(groups.length, 2);

  // Lowest remainingPct comes first
  assert.equal(groups[0].key, 'claude_gpt');
  assert.equal(groups[0].title, 'Claude & GPT');
  assert.equal(groups[0].remainingPct, 95.6);
  assert.equal(groups[0].resetIn, '3h 59m');

  assert.equal(groups[1].key, 'gemini');
  assert.equal(groups[1].title, 'Gemini');
  assert.equal(groups[1].remainingPct, 100.0);
  assert.equal(groups[1].resetIn, '5h');
});

test('groupAgyQuotaModels handles empty or invalid models gracefully', () => {
  assert.deepEqual(groupAgyQuotaModels([]), []);
  assert.deepEqual(groupAgyQuotaModels(null), []);
  assert.deepEqual(groupAgyQuotaModels([{ model: 'claude-opus', remainingPct: null }]), []);
  assert.deepEqual(groupAgyQuotaModels([{ model: 'claude-opus', remainingPct: 'invalid' }]), []);
});

test('groupAgyQuotaModels keeps the most constrained remainingPct within a group', () => {
  const models = [
    { model: 'claude-opus-4-6-thinking', remainingPct: 80.0, resetIn: '2h', resetAtMs: 2000 },
    { model: 'claude-sonnet-4-6', remainingPct: 90.0, resetIn: '4h', resetAtMs: 4000 }
  ];

  const groups = groupAgyQuotaModels(models);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].remainingPct, 80.0);
  assert.equal(groups[0].resetIn, '2h');
});

test('formatAgyQuotaGroups formats groups inline for CLI ls output', () => {
  const models = [
    { model: 'claude-opus-4-6-thinking', remainingPct: 95.6, resetIn: '3h 59m' },
    { model: 'gemini-2.5-flash', remainingPct: 100.0, resetIn: '5h' }
  ];

  assert.equal(
    formatAgyQuotaGroups(models),
    'Claude & GPT: 95.6% (3h 59m) / Gemini: 100.0% (5h)'
  );

  // Compact mode for titles
  assert.equal(
    formatAgyQuotaGroups(models, { compact: true }),
    'Claude & GPT:96%:3h 59m Gemini:100%:5h'
  );
});

test('formatAgyQuotaGroups skips unknown/empty resetIn values cleanly', () => {
  const models = [
    { model: 'claude-opus-4-6-thinking', remainingPct: 95.6, resetIn: 'unknown' },
    { model: 'gemini-2.5-flash', remainingPct: 100.0, resetIn: '' }
  ];

  assert.equal(
    formatAgyQuotaGroups(models),
    'Claude & GPT: 95.6% / Gemini: 100.0%'
  );
});

test('formatUsageLabel renders AGY quotas as groups instead of model names', () => {
  const capturedAt = Date.now();
  const snapshot = {
    capturedAt,
    kind: 'agy_code_assist_quota',
    models: [
      { model: 'claude-opus-4-6-thinking', remainingPct: 95.6, resetIn: '3h 59m' },
      { model: 'claude-sonnet-4-6', remainingPct: 95.6, resetIn: '3h 59m' },
      { model: 'gemini-2.5-flash', remainingPct: 100.0, resetIn: '5h' },
      { model: 'gemini-2.5-pro', remainingPct: 100.0, resetIn: '5h' }
    ]
  };

  const presenter = createUsagePresenterService({
    usageCacheMaxAgeMs: 24 * 60 * 60 * 1000,
    readUsageCache: () => snapshot,
    resolveAccountScope: (provider, selector) => ({
      provider,
      accountRef: `acct_${String(selector).padStart(20, '0')}`
    })
  });

  const label = presenter.formatUsageLabel('agy', '1', 'test@example.com');
  // Must contain group titles
  assert.match(label, /Claude & GPT: 95.6% \(3h 59m\)/);
  assert.match(label, /Gemini: 100.0% \(5h\)/);
  // Must NOT leak individual model names
  assert.doesNotMatch(label, /claude-opus-4-6-thinking/);
  assert.doesNotMatch(label, /gemini-2.5-flash/);
});
