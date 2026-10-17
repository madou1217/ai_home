'use strict';

// 窗口激活是「为了不用而用」：每次探测都是一次真实上游请求。所以默认必须关，
// 且间隔下限必须钉死。配置入口只有命令行 / server config（env 回退已删除）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseServerServeArgs } = require('../lib/server/args');

test('默认关闭，默认间隔 1 小时（兜底节奏），下限 1 小时', () => {
  const parsed = parseServerServeArgs([]);
  assert.equal(parsed.windowActivation, false);
  assert.equal(parsed.windowActivationDefaultIntervalMs, 60 * 60 * 1000);
  assert.equal(parsed.windowActivationMinIntervalMs, 60 * 60 * 1000);
  assert.equal(parsed.windowActivationTickIntervalMs, 10 * 60 * 1000);
  assert.equal(parsed.windowActivationStartDelayMs, 3 * 60 * 1000);
  assert.equal(parsed.windowActivationBatchSize, 4);
  assert.equal(parsed.windowActivationProbeTimeoutMs, 30000);
});

test('--window-activation 打开，--no-window-activation 关闭', () => {
  assert.equal(parseServerServeArgs(['--window-activation']).windowActivation, true);
  assert.equal(parseServerServeArgs(['--no-window-activation']).windowActivation, false);
  // 后写的开关生效。
  assert.equal(parseServerServeArgs(['--window-activation', '--no-window-activation']).windowActivation, false);
});

test('默认间隔低于下限时回落默认 1 小时（且不低于下限）', () => {
  const tooSmall = parseServerServeArgs(['--window-activation-default-interval-ms', '1000']);
  assert.equal(tooSmall.windowActivationDefaultIntervalMs, 60 * 60 * 1000);
  assert.ok(tooSmall.windowActivationDefaultIntervalMs >= tooSmall.windowActivationMinIntervalMs);

  const explicit = parseServerServeArgs(['--window-activation-default-interval-ms', String(2 * 60 * 60 * 1000)]);
  assert.equal(explicit.windowActivationDefaultIntervalMs, 2 * 60 * 60 * 1000);
});

test('下限低于 1 小时回落默认', () => {
  assert.equal(
    parseServerServeArgs(['--window-activation-min-interval-ms', '1000']).windowActivationMinIntervalMs,
    60 * 60 * 1000
  );
});

test('batchSize 与 probeTimeout 落在合理区间', () => {
  const parsed = parseServerServeArgs([
    '--window-activation-batch-size', '100',
    '--window-activation-probe-timeout-ms', '1'
  ]);
  assert.equal(parsed.windowActivationBatchSize, 32);
  assert.equal(parsed.windowActivationProbeTimeoutMs, 5000);
});

test('命令行可设置各数值项', () => {
  const parsed = parseServerServeArgs([
    '--window-activation',
    '--window-activation-default-interval-ms', String(3 * 60 * 60 * 1000),
    '--window-activation-min-interval-ms', String(30 * 60 * 1000),
    '--window-activation-tick-interval-ms', String(5 * 60 * 1000),
    '--window-activation-start-delay-ms', '1000',
    '--window-activation-batch-size', '2',
    '--window-activation-probe-timeout-ms', '15000'
  ]);
  assert.equal(parsed.windowActivation, true);
  assert.equal(parsed.windowActivationDefaultIntervalMs, 3 * 60 * 60 * 1000);
  assert.equal(parsed.windowActivationMinIntervalMs, 30 * 60 * 1000);
  assert.equal(parsed.windowActivationTickIntervalMs, 5 * 60 * 1000);
  assert.equal(parsed.windowActivationStartDelayMs, 1000);
  assert.equal(parsed.windowActivationBatchSize, 2);
  assert.equal(parsed.windowActivationProbeTimeoutMs, 15000);
});
