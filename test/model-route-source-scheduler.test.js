'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderModelRouteSources } = require('../lib/server/model-route-source-scheduler');

const entry = (accountRef, provider, remainingPct = 80) => ({ account: { accountRef, remainingPct }, provider });

test('single-source requests keep their only route', () => {
  assert.deepEqual(orderModelRouteSources({ hasAlias: true, hasNative: false }), ['alias']);
  assert.deepEqual(orderModelRouteSources({ hasAlias: false, hasNative: true }), ['native']);
  assert.deepEqual(orderModelRouteSources({ hasAlias: false, hasNative: false }), []);
});

test('alias and native accounts share one pool weighted like the account selector', () => {
  const aliasAccounts = Array.from({ length: 9 }, (_, i) => entry(`kiro-${i}`, 'kiro'));
  const nativeAccounts = [entry('claude-0', 'claude')];
  let aliasFirst = 0;
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2000; i += 1) {
    const order = orderModelRouteSources({ hasAlias: true, hasNative: true, aliasAccounts, nativeAccounts, random });
    if (order[0] === 'alias') aliasFirst += 1;
  }
  // 10 个等权账号里 9 个在别名路线：首选约 90%，不再是对半。
  assert.ok(aliasFirst > 1700 && aliasFirst < 1900, `alias first ${aliasFirst}/2000`);
});

test('an empty side yields to the side that still has accounts', () => {
  assert.deepEqual(
    orderModelRouteSources({ hasAlias: true, hasNative: true, aliasAccounts: [], nativeAccounts: [entry('c', 'claude')] }),
    ['native', 'alias']
  );
  assert.deepEqual(
    orderModelRouteSources({ hasAlias: true, hasNative: true, aliasAccounts: [entry('k', 'kiro')], nativeAccounts: [] }),
    ['alias', 'native']
  );
});

test('explicit round-robin rotates by account count instead of halves', () => {
  const cursors = {};
  const input = {
    hasAlias: true,
    hasNative: true,
    strategy: 'round-robin',
    aliasAccounts: [entry('k1', 'kiro'), entry('k2', 'kiro'), entry('k3', 'kiro')],
    nativeAccounts: [entry('c1', 'claude')],
    cursors,
    cursorKey: 'claude'
  };
  const firsts = Array.from({ length: 8 }, () => orderModelRouteSources(input)[0]);
  assert.deepEqual(firsts, ['alias', 'alias', 'alias', 'native', 'alias', 'alias', 'alias', 'native']);
});

test('without account snapshots the order still alternates', () => {
  const cursors = {};
  const input = { hasAlias: true, hasNative: true, cursors, cursorKey: 'claude' };
  assert.deepEqual(orderModelRouteSources(input), ['alias', 'native']);
  assert.deepEqual(orderModelRouteSources(input), ['native', 'alias']);
});
