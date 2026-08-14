'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orderModelRouteSources
} = require('../lib/server/model-route-source-scheduler');

test('route source fairness is independent of random account selection', () => {
  const cursors = {};
  const input = {
    hasAlias: true,
    hasNative: true,
    strategy: 'random',
    random: () => 0,
    cursors,
    cursorKey: 'claude'
  };

  assert.deepEqual(orderModelRouteSources(input), ['alias', 'native']);
  assert.deepEqual(orderModelRouteSources(input), ['native', 'alias']);
});
