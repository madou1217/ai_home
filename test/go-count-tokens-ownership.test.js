'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const manifest = require('../contracts/route-ownership/manifest.json');
const {
  classifyRoute,
  compileRouteTable,
  resolveGoOwnedEntryIds
} = require('../lib/server/go-core-route-ownership');

test('Anthropic count_tokens is owned by Go after local parity coverage', () => {
  const entry = manifest.entries.find((item) => item.id === 'gateway.anthropic.count_tokens');
  assert.ok(entry, 'count_tokens route must be declared');
  assert.equal(entry.production_owner, 'go');
  assert.equal(entry.migration_state, 'go_owned');
  assert.equal(entry.go_implementation, 'go_owned');
});

test('count_tokens ownership is discoverable by the Go route classifier', () => {
  const table = compileRouteTable(manifest);
  assert.equal(classifyRoute(table, {
    transport: 'http',
    method: 'POST',
    pathname: '/v1/messages/count_tokens'
  }), 'gateway.anthropic.count_tokens');

  const ownership = resolveGoOwnedEntryIds(manifest, []);
  assert.equal(ownership.errors.length, 0);
  assert.equal(ownership.entryIds.has('gateway.anthropic.count_tokens'), true);
});
