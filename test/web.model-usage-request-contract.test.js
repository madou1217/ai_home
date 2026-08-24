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
const MODEL_USAGE_API = path.join(__dirname, '../web/src/services/api.ts');
const MODEL_USAGE_REQUEST_SECTION = path.join(
  __dirname,
  '../web/src/features/model-usage/RequestDetailsSection.tsx'
);

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
  const requestsRoute = matchRemoteManagementRoute('GET', 'usage/requests');
  const descriptor = buildControlPlaneDescriptor();

  assert.equal(route && route.key, 'usage.dashboard');
  assert.equal(route && route.remotePath, '/v0/management/usage/dashboard');
  assert.equal(requestsRoute && requestsRoute.key, 'usage.requests');
  assert.equal(requestsRoute && requestsRoute.remotePath, '/v0/management/usage/requests');
  assert.equal(descriptor.capabilities.management.includes('usage.dashboard'), true);
  assert.equal(descriptor.capabilities.management.includes('usage.requests'), true);
});

test('model usage page loads request details on demand without unsupported columns', () => {
  const pageSource = fs.readFileSync(MODEL_USAGE_PAGE, 'utf8');
  const apiSource = fs.readFileSync(MODEL_USAGE_API, 'utf8');

  assert.equal(fs.existsSync(MODEL_USAGE_REQUEST_SECTION), true);
  const sectionSource = fs.readFileSync(MODEL_USAGE_REQUEST_SECTION, 'utf8');
  const requestCalls = pageSource.match(/modelUsageAPI\.requests\s*\(/g) || [];

  assert.equal(requestCalls.length, 1);
  assert.match(pageSource, /<RequestDetailsSection/);
  assert.match(pageSource, /const loadRequestDetails = useCallback/);
  assert.match(pageSource, /requested=\{requestDetailsRequested\}/);
  assert.match(pageSource, /onRequest=\{\(\) => void loadRequestDetails\(\)\}/);
  assert.match(apiSource, /\/webui\/management\/usage\/requests/);
  assert.match(sectionSource, /REQUEST_DETAIL_COLUMN_CONTRACTS/);
  assert.match(sectionSource, /仅在需要时读取/);
  assert.match(sectionSource, /ListTable/);
  assert.doesNotMatch(sectionSource, /apiKey|accountRef|密钥|分组/);
});
