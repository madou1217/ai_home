'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAccountSwitchSequence } = require('../lib/cli/services/pty/account-switch-shortcut');

test('Ctrl-Alt-A is recognised in every terminal encoding', () => {
  assert.equal(isAccountSwitchSequence('\x1b\x01'), true);
  assert.equal(isAccountSwitchSequence('\x1b[97;7u'), true);
  assert.equal(isAccountSwitchSequence('\x1b[65;7u'), true);
  assert.equal(isAccountSwitchSequence('\x1b[27;7;97~'), true);
  assert.equal(isAccountSwitchSequence('\x1b[27;7;65~'), true);
});

test('ordinary input never triggers a switch', () => {
  assert.equal(isAccountSwitchSequence('a'), false);
  assert.equal(isAccountSwitchSequence('\x01'), false);
  assert.equal(isAccountSwitchSequence('\x1b'), false);
  assert.equal(isAccountSwitchSequence('\x1b\x01x'), false);
  assert.equal(isAccountSwitchSequence(''), false);
  assert.equal(isAccountSwitchSequence(null), false);
});
