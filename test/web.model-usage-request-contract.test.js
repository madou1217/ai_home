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
const MODEL_USAGE_BREAKDOWN_DRAWER = path.join(
  __dirname,
  '../web/src/features/model-usage/UsageBreakdownDrawer.tsx'
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

test('model usage drilldowns reuse the dashboard snapshot end time', () => {
  const source = fs.readFileSync(MODEL_USAGE_PAGE, 'utf8');

  assert.match(source, /to: formatDateTime\(range\[1\]\)/);
  assert.match(source, /modelUsageAPI\.breakdown\(\{\s*\.\.\.query,/);
  assert.match(source, /modelUsageAPI\.requests\(\{ \.\.\.query, limit: REQUEST_DETAIL_LIMIT \}\)/);
  assert.doesNotMatch(source, /to: .*formatDate\(range\[1\]\)/);
});

test('usage dashboard is declared across the remote management boundary', () => {
  const route = matchRemoteManagementRoute('GET', 'usage/dashboard');
  const breakdownRoute = matchRemoteManagementRoute('GET', 'usage/breakdown');
  const requestsRoute = matchRemoteManagementRoute('GET', 'usage/requests');
  const descriptor = buildControlPlaneDescriptor();

  assert.equal(route && route.key, 'usage.dashboard');
  assert.equal(route && route.remotePath, '/v0/management/usage/dashboard');
  assert.equal(breakdownRoute && breakdownRoute.key, 'usage.breakdown');
  assert.equal(breakdownRoute && breakdownRoute.remotePath, '/v0/management/usage/breakdown');
  assert.equal(requestsRoute && requestsRoute.key, 'usage.requests');
  assert.equal(requestsRoute && requestsRoute.remotePath, '/v0/management/usage/requests');
  assert.equal(descriptor.capabilities.management.includes('usage.dashboard'), true);
  assert.equal(descriptor.capabilities.management.includes('usage.breakdown'), true);
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

test('model and session breakdowns expose total and component token metrics', () => {
  const source = fs.readFileSync(MODEL_USAGE_BREAKDOWN_DRAWER, 'utf8');
  const totalTokenColumns = source.match(/dataIndex: 'totalTokens'/g) || [];

  assert.equal(totalTokenColumns.length, 2);
  assert.match(source, /<span>总 Tokens<\/span><strong>\{formatTokens\(summary\.totalTokens\)\}<\/strong>/);
  assert.match(source, /title: 'Input'/);
  assert.match(source, /title: 'Output'/);
  assert.match(source, /title: 'Cache'/);
  assert.match(source, /title: '缓存率'/);
  assert.match(source, /title: '成本'/);
});
