'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { listProviderDefinitions } = require('../lib/provider-catalog');
const { RESOURCE_TYPES, buildNativeResourceMatrix, validateNativeResourceMatrix } = require('../lib/native-resources/resource-status');
const { createProviderResourceRegistry } = require('../lib/native-resources/provider-resource-registry');

test('resource registry reports every provider and resource with a reason when not supported', () => {
  const registry = createProviderResourceRegistry({ definitions: listProviderDefinitions() });
  const matrix = registry.matrix();
  assert.equal(Object.keys(matrix).length, listProviderDefinitions().length);
  validateNativeResourceMatrix(matrix);
  for (const provider of registry.listProviders()) {
    for (const resource of RESOURCE_TYPES) {
      const item = registry.get(provider, resource);
      assert.ok(item.state);
      if (item.state !== 'supported') assert.ok(item.reason);
    }
  }
});

test('unknown provider/resource fails closed', () => {
  const registry = createProviderResourceRegistry({ definitions: [] });
  assert.deepEqual(registry.get('missing', 'mcp'), { state: 'unsupported', reason: 'provider_or_resource_unknown' });
});
