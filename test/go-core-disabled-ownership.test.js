'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEffectiveGoOwnership
} = require('../lib/server/go-core-route-ownership');

const manifest = {
  entries: [
    {
      id: 'gateway.openai.chat_completions',
      production_owner: 'go',
      migration_state: 'go_owned',
      go_routes: ['/v1/responses']
    }
  ]
};

test('disabled Go Core has no effective route ownership so Node can serve', () => {
  const ownership = resolveEffectiveGoOwnership(manifest, [], false);

  assert.deepEqual([...ownership.entryIds], []);
  assert.deepEqual(ownership.canaryIds, []);
  assert.deepEqual(ownership.errors, []);
});

test('enabled Go Core keeps manifest route ownership', () => {
  const ownership = resolveEffectiveGoOwnership(manifest, [], true);

  assert.deepEqual([...ownership.entryIds], ['gateway.openai.chat_completions']);
  assert.deepEqual(ownership.errors, []);
});
