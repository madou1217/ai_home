'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSwitchTarget,
  isSwitchableProvider,
  listSwitchableProviders,
  parseSwitchTarget
} = require('../lib/account/provider-family-pool');

test('codebuddy and codebuddycn share a switch pool, current provider first', () => {
  assert.deepEqual(listSwitchableProviders('codebuddy'), ['codebuddy', 'codebuddycn']);
  assert.deepEqual(listSwitchableProviders('codebuddycn'), ['codebuddycn', 'codebuddy']);
  assert.equal(isSwitchableProvider('codebuddy', 'codebuddycn'), true);
  assert.equal(isSwitchableProvider('codebuddycn', 'codebuddy'), true);
});

test('unrelated providers never enter the family pool', () => {
  assert.deepEqual(listSwitchableProviders('codex'), ['codex']);
  assert.equal(isSwitchableProvider('codex', 'codebuddy'), false);
  assert.equal(isSwitchableProvider('codebuddy', 'workbuddy'), false);
});

test('switch targets parse numeric, qualified and accountRef forms', () => {
  assert.deepEqual(parseSwitchTarget('2'), { provider: '', cliAccountId: '2', accountRef: '' });
  assert.deepEqual(parseSwitchTarget('codebuddycn:2'), {
    provider: 'codebuddycn', cliAccountId: '2', accountRef: ''
  });
  assert.deepEqual(parseSwitchTarget('codebuddycn/2'), {
    provider: 'codebuddycn', cliAccountId: '2', accountRef: ''
  });
  const ref = 'acct_' + 'a'.repeat(20);
  assert.deepEqual(parseSwitchTarget(ref), { provider: '', cliAccountId: '', accountRef: ref });
  assert.equal(parseSwitchTarget('nonsense'), null);
});

test('the display label only adds a provider prefix for cross-provider targets', () => {
  assert.equal(formatSwitchTarget({ provider: 'codebuddy', cliAccountId: '2' }, 'codebuddy'), '2');
  assert.equal(formatSwitchTarget({ provider: 'codebuddycn', cliAccountId: '2' }, 'codebuddy'), 'codebuddycn:2');
  assert.equal(formatSwitchTarget({ provider: 'codebuddycn', accountRef: 'acct_x' }, 'codebuddy'), 'acct_x');
});
