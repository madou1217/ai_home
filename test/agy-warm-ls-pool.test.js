const test = require('node:test');
const assert = require('node:assert/strict');

const { entrySupportsModel, warmSupportsModel } = require('../lib/server/agy-warm-ls-pool');

test('entrySupportsModel: no entry never supports', () => {
  assert.equal(entrySupportsModel(null, 'gemini-3-pro'), false);
  assert.equal(entrySupportsModel(undefined, ''), false);
});

test('entrySupportsModel: empty requested model reuses the warm session model', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, ''), true);
  assert.equal(entrySupportsModel({ model: '' }, ''), true);
});

test('entrySupportsModel: matching model uses warm fast path', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, 'gemini-3-pro'), true);
});

test('entrySupportsModel: model switch (or legacy entry without model) forces cold spawn', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, 'claude-sonnet-4-6'), false);
  // 旧暖机条目没记录模型：请求显式模型时宁可冷启动一次，之后条目带模型自愈。
  assert.equal(entrySupportsModel({ model: '' }, 'claude-sonnet-4-6'), false);
});

test('warmSupportsModel: unknown account has no live warm entry', () => {
  assert.equal(warmSupportsModel('no-such-account', 'gemini-3-pro'), false);
});
