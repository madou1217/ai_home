'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { listProviderDefinitions } = require('../lib/provider-catalog');
const { createProviderResourceDoctor } = require('../lib/native-resources/provider-resource-doctor');
const { RESOURCE_TYPES } = require('../lib/native-resources/resource-status');
test('provider doctor reports every contract provider and resource with evidence', () => {
  const report = createProviderResourceDoctor({ definitions: listProviderDefinitions(), nativeBinaries: {} }).capabilities();
  assert.equal(report.providers.length, listProviderDefinitions().length);
  for (const row of report.providers) {
    assert.ok(row.provider); assert.ok(row.source);
    for (const resource of RESOURCE_TYPES) { assert.ok(row.resources[resource].state); if (row.resources[resource].state !== 'supported') assert.ok(row.resources[resource].reason); }
  }
});
test('provider doctor exposes imported host gaps without claiming runtime support', () => {
  const report = createProviderResourceDoctor({ definitions: listProviderDefinitions(), nativeBinaries: {} }).capabilities();
  assert.deepEqual(report.hostAdapters.map(x => x.host), ['deepseek', 'opencode', 'pi', 'aih']);
  assert.equal(report.hostAdapters.find(x => x.host === 'deepseek').state, 'adapter-needed');
  assert.equal(report.hostAdapters.find(x => x.host === 'pi').state, 'runtime-unavailable');
  assert.equal(report.hostAdapters.find(x => x.host === 'opencode').state, 'supported');
});
test('provider doctor managed state only contains redacted metadata', () => {
  const report = createProviderResourceDoctor({ definitions: listProviderDefinitions(), nativeBinaries: { claude: '/bin/sh' }, probeRuntime: false, managed: { resources: [{ kind: 'mcp', id: 'demo', provider: 'claude', command: 'secret', argCount: 2, envKeys: ['TOKEN'], enabled: true }] } }).doctor();
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /secret/); assert.match(text, /TOKEN/); assert.equal(report.providers.find(x => x.provider === 'claude').runtime.available, true);
});
