const test = require('node:test');
const assert = require('node:assert/strict');
const { getDefaultParallelism } = require('../lib/runtime/parallelism');

test('getDefaultParallelism prefers availableParallelism when present', () => {
  const value = getDefaultParallelism({
    availableParallelism: () => 12,
    cpus: () => [{}, {}]
  });
  assert.equal(value, 12);
});

test('getDefaultParallelism falls back to cpus length', () => {
  const value = getDefaultParallelism({
    cpus: () => [{}, {}, {}]
  });
  assert.equal(value, 3);
});

test('getDefaultParallelism always returns at least 1', () => {
  const value = getDefaultParallelism({
    availableParallelism: () => 0,
    cpus: () => []
  });
  assert.equal(value, 1);
});
