'use strict';

// 窗口激活是「为了不用而用」：每次探测都是一次真实上游请求。所以默认必须关，
// 且间隔下限必须钉死。这几条断言把默认值与开关路径锁住。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseServerServeArgs } = require('../lib/server/args');

const ENV_KEYS = [
  'AIH_SERVER_WINDOW_ACTIVATION',
  'AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS',
  'AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS',
  'AIH_SERVER_WINDOW_ACTIVATION_TICK_INTERVAL_MS',
  'AIH_SERVER_WINDOW_ACTIVATION_START_DELAY_MS',
  'AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE',
  'AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS'
];

function withEnv(patch, fn) {
  const previous = {};
  ENV_KEYS.forEach((key) => { previous[key] = process.env[key]; delete process.env[key]; });
  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return fn();
  } finally {
    ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

test('默认关闭，默认间隔 1 小时（兜底节奏），下限 1 小时', () => {
  withEnv({}, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.windowActivation, false);
    assert.equal(parsed.windowActivationDefaultIntervalMs, 60 * 60 * 1000);
    assert.equal(parsed.windowActivationMinIntervalMs, 60 * 60 * 1000);
    assert.equal(parsed.windowActivationTickIntervalMs, 10 * 60 * 1000);
    assert.equal(parsed.windowActivationStartDelayMs, 3 * 60 * 1000);
    assert.equal(parsed.windowActivationBatchSize, 4);
    assert.equal(parsed.windowActivationProbeTimeoutMs, 30000);
  });
});

test('--window-activation 打开，--no-window-activation 关闭', () => {
  withEnv({}, () => {
    assert.equal(parseServerServeArgs(['--window-activation']).windowActivation, true);
    assert.equal(parseServerServeArgs(['--no-window-activation']).windowActivation, false);
  });
});

test('AIH_SERVER_WINDOW_ACTIVATION=1 打开，命令行可覆盖', () => {
  withEnv({ AIH_SERVER_WINDOW_ACTIVATION: '1' }, () => {
    assert.equal(parseServerServeArgs([]).windowActivation, true);
    assert.equal(parseServerServeArgs(['--no-window-activation']).windowActivation, false);
  });
});

test('默认间隔低于下限时回落默认 1 小时（且不低于下限）', () => {
  withEnv({ AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS: '1000' }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.windowActivationDefaultIntervalMs, 60 * 60 * 1000);
    assert.ok(parsed.windowActivationDefaultIntervalMs >= parsed.windowActivationMinIntervalMs);
  });
  withEnv({ AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS: String(2 * 60 * 60 * 1000) }, () => {
    assert.equal(parseServerServeArgs([]).windowActivationDefaultIntervalMs, 2 * 60 * 60 * 1000);
  });
});

test('下限低于 1 小时回落默认', () => {
  withEnv({ AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS: '1000' }, () => {
    assert.equal(parseServerServeArgs([]).windowActivationMinIntervalMs, 60 * 60 * 1000);
  });
});

test('batchSize 与 probeTimeout 落在合理区间', () => {
  withEnv({ AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE: '100', AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS: '1' }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.windowActivationBatchSize, 32);
    assert.equal(parsed.windowActivationProbeTimeoutMs, 5000);
  });
});

test('命令行可设置各数值项', () => {
  withEnv({}, () => {
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
});
