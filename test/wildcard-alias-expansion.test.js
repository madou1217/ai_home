'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listWildcardAliasModels } = require('../lib/server/wildcard-alias-expansion');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-31T00:00:00Z');
const row = (id, family, daysAgo) => ({ id, family, releasedAt: NOW - daysAgo * DAY });

const ROWS = [
  row('claude-opus-5-5', 'claude-opus', 40),
  row('claude-opus-5', 'claude-opus', 100),
  row('claude-opus-4-8', 'claude-opus', 150),
  row('claude-opus-4-7', 'claude-opus', 200),
  row('claude-opus-4-5-20251101', 'claude-opus', 40),
  row('claude-haiku-5-5', 'claude-haiku', 20),
  row('claude-haiku-4-5', 'claude-haiku', 380),
  row('gpt-6.1-sol', 'gpt', 10)
];

test('wildcard alias lists the newest 3 generations per family, nothing older than a year', () => {
  assert.deepEqual(listWildcardAliasModels('claude-*', { now: NOW, rows: ROWS }), [
    'claude-haiku-5-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8'
  ]);
});

test('wildcard alias expansion respects a narrower prefix', () => {
  assert.deepEqual(
    listWildcardAliasModels('claude-opus-*', { now: NOW, rows: ROWS }),
    ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']
  );
});

test('wildcard alias expansion rejects non-wildcard and too-short patterns', () => {
  assert.deepEqual(listWildcardAliasModels('claude-opus-5-5', { now: NOW, rows: ROWS }), []);
  assert.deepEqual(listWildcardAliasModels('c*', { now: NOW, rows: ROWS }), []);
});

test('wildcard alias expansion reads the models.dev snapshot by default', () => {
  const listed = listWildcardAliasModels('claude-*', { now: NOW });
  assert.ok(listed.includes('claude-opus-5-5'), listed.join(','));
  assert.ok(listed.every((id) => !/-\d{8}$/.test(id)), 'dated snapshot ids must be dropped');
  assert.ok(!listed.includes('claude-3-haiku-20240307'));
});
