'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, metricDelta } = require('../scripts/web-terminal-resize-benchmark');

test('benchmark accepts explicit browser, repeat count and isolation options', () => {
  assert.deepEqual(parseArgs(['--browser', '/opt/chromium', '--runs', '2', '--tmpdir', '/tmp/fixtures', '--software', '--no-sandbox', '--compare-styles']), {
    browser: '/opt/chromium', runs: 2, tmpdir: '/tmp/fixtures', software: true, noSandbox: true, compareStyles: true, compareBlur: false, help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs([]), /--browser is required/);
  assert.throws(() => parseArgs(['--browser', '--runs', '2']), /--browser requires a value/);
  assert.throws(() => parseArgs(['--browser', '/bin/chrome', '--tmpdir']), /--tmpdir requires a value/);
  assert.throws(() => parseArgs(['--browser', '/bin/chrome', '--runs', '0']), /--runs must be/);
  assert.throws(() => parseArgs(['--browser', '/bin/chrome', '--surprise']), /unknown option/);
  assert.equal(parseArgs(['--browser', '/bin/chrome', '--compare-blur']).compareBlur, true);
  assert.throws(() => parseArgs(['--browser', '/bin/chrome', '--compare-blur', '--compare-styles']), /choose one comparison mode/);
});

test('browser work reports deltas only for relevant metrics', () => {
  const before = [{ name: 'LayoutCount', value: 10 }, { name: 'TaskDuration', value: 1.25 }];
  const after = [{ name: 'LayoutCount', value: 16 }, { name: 'TaskDuration', value: 1.57523 }, { name: 'Irrelevant', value: 100 }];
  assert.deepEqual(metricDelta(before, after), { LayoutCount: 6, TaskDuration: 0.3252 });
});
