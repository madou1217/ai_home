'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseServerConfigArgs, toPublicServerConfig } = require('../lib/server/server-config-command');

test('server config accepts the Go Core opt-in and canary route flags', () => {
  assert.deepEqual(
    parseServerConfigArgs(['set', '--go-core', '--go-core-routes', 'gateway.models.list, gateway.props']).patch,
    { goCoreEnabled: true, goCoreRoutes: ['gateway.models.list', 'gateway.props'] }
  );
  assert.deepEqual(parseServerConfigArgs(['set', '--go-core-routes=gateway.props']).patch, { goCoreRoutes: ['gateway.props'] });
  assert.deepEqual(
    parseServerConfigArgs(['set', '--clear-go-core-routes', '--no-go-core']).patch,
    { goCoreRoutes: [], goCoreEnabled: false }
  );
  assert.throws(() => parseServerConfigArgs(['set', '--go-core-routes']), /Invalid --go-core-routes value/);
});

test('public server config exposes the Go Core settings', () => {
  const view = toPublicServerConfig({ goCoreEnabled: true, goCoreRoutes: ['gateway.props'] });
  assert.equal(view.goCoreEnabled, true);
  assert.deepEqual(view.goCoreRoutes, ['gateway.props']);
});

test('server config accepts the Go upstream error rule provider flags', () => {
  assert.deepEqual(
    parseServerConfigArgs(['set', '--upstream-error-rules', ' Codex , claude,Codex']).patch,
    { upstreamErrorRuleProviders: ['codex', 'claude'] }
  );
  assert.deepEqual(
    parseServerConfigArgs(['set', '--upstream-error-rules=codex,claude']).patch,
    { upstreamErrorRuleProviders: ['codex', 'claude'] }
  );
  assert.deepEqual(
    parseServerConfigArgs(['set', '--clear-upstream-error-rules']).patch,
    { upstreamErrorRuleProviders: [] }
  );
  assert.throws(
    () => parseServerConfigArgs(['set', '--upstream-error-rules']),
    /Invalid --upstream-error-rules value/
  );
});

test('public server config exposes the Go upstream error rule providers', () => {
  assert.deepEqual(
    toPublicServerConfig({ upstreamErrorRuleProviders: ['codex'] }).upstreamErrorRuleProviders,
    ['codex']
  );
  assert.deepEqual(toPublicServerConfig({}).upstreamErrorRuleProviders, []);
});
