'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const build = require('../web/scripts/build.cjs');

test('web build refuses a host below the measured reliable memory floor', () => {
  assert.equal(build.memoryMiB(1024 * 1024 * 1024), 1024);
  assert.equal(build.hasReliableBuildMemory(1024 * 1024 * 1024), false);
  assert.equal(build.hasReliableBuildMemory(1536 * 1024 * 1024), true);
});

test('web build heap stays bounded and preserves explicit Node options', () => {
  const env = {};
  build.ensureBuildHeap(env, 1905 * 1024 * 1024);
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=1024/);

  const explicit = { NODE_OPTIONS: '--max-old-space-size=640' };
  build.ensureBuildHeap(explicit, 1905 * 1024 * 1024);
  assert.equal(explicit.NODE_OPTIONS, '--max-old-space-size=640');
});
