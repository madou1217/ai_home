'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  withHiddenWindowsConsole
} = require('../lib/runtime/hidden-child-process-options');

test('hidden child process options always suppress Windows console windows', () => {
  const input = { stdio: 'ignore', windowsHide: false };
  const result = withHiddenWindowsConsole(input);

  assert.deepEqual(result, { stdio: 'ignore', windowsHide: true });
  assert.equal(input.windowsHide, false);
});
