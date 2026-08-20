'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildControlPlaneDescriptor } = require('../lib/server/control-plane-descriptor');
const {
  matchRemoteManagementRoute
} = require('../lib/server/remote/remote-management-routes');

const MODEL_USAGE_PAGE = path.join(__dirname, '../web/src/pages/ModelUsage.tsx');

test('model usage page starts one progressive dashboard query instead of waiting for one snapshot', () => {
  const source = fs.readFileSync(MODEL_USAGE_PAGE, 'utf8');
  const startCalls = source.match(/modelUsageAPI\.startDashboardQuery\s*\(/g) || [];

  assert.equal(startCalls.length, 1);
  assert.match(source, /modelUsageAPI\.watchDashboardQueries\s*\(/);
  assert.match(source, /modelUsageAPI\.cancelDashboardQuery\s*\(/);
  assert.doesNotMatch(source, /modelUsageAPI\.(?:dashboard|stats|models|sessions)\s*\(/);
  assert.match(source, /completedShards/);
  assert.match(source, /totalShards/);
  assert.match(
    source,
    /const handleRefreshUsage = \(\) => requestUsageRefresh\(false\);/
  );
});

test('usage dashboard is declared across the remote management boundary', () => {
  const route = matchRemoteManagementRoute('GET', 'usage/dashboard');
  const descriptor = buildControlPlaneDescriptor();

  assert.equal(route && route.key, 'usage.dashboard');
  assert.equal(route && route.remotePath, '/v0/management/usage/dashboard');
  assert.equal(descriptor.capabilities.management.includes('usage.dashboard'), true);
});
