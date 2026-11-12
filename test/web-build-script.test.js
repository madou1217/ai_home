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
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=1104/);

  const explicit = { NODE_OPTIONS: '--max-old-space-size=640' };
  build.ensureBuildHeap(explicit, 1905 * 1024 * 1024);
  assert.equal(explicit.NODE_OPTIONS, '--max-old-space-size=640');
});

// 回归守卫：2026-11-02 的发布因为上限停在 1024 MiB，压缩构建在约 1000 MiB old space
// 处 OOM。上限必须高于压缩构建的实测峰值，否则大内存宿主照样会死。
test('web build gives a big host enough heap for a minified build', () => {
  const env = {};
  build.ensureBuildHeap(env, 64 * 1024 * 1024 * 1024);
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=2048/);
  assert.ok(build.MAX_BUILD_HEAP_MIB > 1024, 'the cap must stay above the measured minified peak');
  assert.ok(build.MINIFIED_BUILD_HEAP_MIB > 1024, 'a minified build needs more than the old 1 GiB cap');
});

test('web build drops minification when the heap budget cannot cover it', () => {
  const tight = { NODE_OPTIONS: '--max-old-space-size=1104' };
  assert.equal(build.effectiveHeapMiB(tight, 1905 * 1024 * 1024), 1104);
  assert.equal(build.shouldDisableCompression(tight, 1104), true);

  const roomy = { NODE_OPTIONS: '--max-old-space-size=2048' };
  assert.equal(build.shouldDisableCompression(roomy, 2048), false);

  const explicit = { COMPRESS: 'css', NODE_OPTIONS: '--max-old-space-size=1104' };
  assert.equal(build.shouldDisableCompression(explicit, 1104), false, 'explicit COMPRESS wins');
});

// 回归守卫：收尾阶段的崩溃不能被 buildComplete 吞掉。旧代码只要 buildComplete 为真
// 就写 0，把 OOM 当成功，发布脚本于是拿着半成品继续往后跑。
test('web build treats a crash after the artifact landed as a failure', () => {
  assert.equal(build.resolveBuildExitCode({ buildComplete: true, code: 1, signal: null, terminating: false }), 1);
  assert.equal(build.resolveBuildExitCode({ buildComplete: true, code: null, signal: 'SIGABRT', terminating: false }), 1);
});

test('web build still accepts a clean exit and its own shutdown', () => {
  assert.equal(build.resolveBuildExitCode({ buildComplete: true, code: 0, signal: null, terminating: false }), 0);
  assert.equal(build.resolveBuildExitCode({ buildComplete: true, code: null, signal: 'SIGTERM', terminating: true }), 0);
  assert.equal(build.resolveBuildExitCode({ buildComplete: false, code: 0, signal: null, terminating: false }), 0);
  assert.equal(build.resolveBuildExitCode({ buildComplete: false, code: 1, signal: null, terminating: false }), 1);
});
