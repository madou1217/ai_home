'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOW_MEMORY_SERVER_LIMIT_BYTES,
  parseServerServeArgs,
  shouldEnableModelUsageScan
} = require('../lib/server/args');

function fakeCgroup(bytes) {
  return {
    readFileSync() {
      return String(bytes);
    }
  };
}

test('small cgroup hosts disable background usage scans by default', () => {
  assert.equal(
    shouldEnableModelUsageScan({
      fs: fakeCgroup(1024 * 1024 * 1024),
      totalMemoryFn: () => 1024 * 1024 * 1024
    }),
    false
  );
  assert.equal(
    shouldEnableModelUsageScan({
      fs: fakeCgroup(3 * 1024 * 1024 * 1024),
      totalMemoryFn: () => 3 * 1024 * 1024 * 1024
    }),
    true
  );
  assert.equal(LOW_MEMORY_SERVER_LIMIT_BYTES, 2048 * 1024 * 1024);
});

test('explicit model usage scan flag overrides the low-memory default', () => {
  const parsed = parseServerServeArgs(['--model-usage-scan']);
  assert.equal(parsed.modelUsageScan, true);
});
