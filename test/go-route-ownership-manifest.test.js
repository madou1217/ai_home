'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'contracts/route-ownership/manifest.json'),
  'utf8',
));
const {
  collectGatewayRoutes,
  comparableNodeRoutes,
} = require('../scripts/collect-gateway-routes');

const EXPECTED_MISSING_GO_PATHS = [
  '/v1{beta?}/models/{model}:generateContent',
  '/v1{beta?}/models/{model}:streamGenerateContent',
  '/v1/blobs/{id}',
  '/v1/images/edits',
  '/v1/images/generations',
  '/v1/messages/count_tokens',
  '/v1/models/{id}',
];

function endpointPaths(routes, transport) {
  return new Set(routes
    .filter((route) => route.kind === 'endpoint')
    .filter((route) => !transport || route.transport === transport)
    .map((route) => route.path));
}

function assertRouteEvidence(route) {
  assert.ok(
    ['endpoint', 'guard', 'fallback'].includes(route.kind),
    `路由必须有明确分类: ${JSON.stringify(route)}`,
  );
  assert.equal(route.route_kind, route.kind);
  assert.ok(['http', 'websocket'].includes(route.transport));
  assert.ok(Array.isArray(route.methods) && route.methods.length > 0);
  assert.ok(route.source && typeof route.source.file === 'string');
  assert.ok(Number.isInteger(route.source.line) && route.source.line > 0);
  assert.ok(route.source.expression);
  assert.ok(route.source.raw_line);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, route.source.file)),
    true,
    `路由源文件不存在: ${route.source.file}`,
  );
}

function assertManifestRouteSpec(route, entryId) {
  assert.equal(typeof route.path, 'string', `${entryId} 缺少 path`);
  assert.ok(route.path.startsWith('/'), `${entryId} 的 path 必须是绝对路径`);
  assert.ok(Array.isArray(route.methods) && route.methods.length > 0);
  assert.ok(['http', 'websocket'].includes(route.transport));
}

test('route ownership manifest 与当前源码采集基线一致', () => {
  const routes = collectGatewayRoutes();
  const nodeEndpoints = routes.node.routes.filter((route) => route.kind === 'endpoint');
  const goEndpoints = routes.go.routes.filter((route) => route.kind === 'endpoint');
  const nodeComparable = comparableNodeRoutes(routes.node.routes);
  const expectedBaseline = {
    collector_schema_version: routes.schema_version,
    node: {
      route_records: routes.node.total,
      endpoint_records: routes.node.endpoint_count,
      unique_endpoint_patterns: endpointPaths(routes.node.routes).size,
      unique_http_endpoint_patterns: endpointPaths(routes.node.routes, 'http').size,
      unique_websocket_endpoint_patterns: endpointPaths(routes.node.routes, 'websocket').size,
      guard_records: routes.node.guard_count,
      fallback_records: routes.node.fallback_count,
    },
    go: {
      route_records: routes.go.total,
      endpoint_records: routes.go.endpoint_count,
      unique_endpoint_patterns: endpointPaths(routes.go.routes).size,
      unique_http_endpoint_patterns: endpointPaths(routes.go.routes, 'http').size,
      unique_websocket_endpoint_patterns: endpointPaths(routes.go.routes, 'websocket').size,
      guard_records: routes.go.guard_count,
      fallback_records: routes.go.fallback_count,
    },
    comparable_node_http_endpoint_records: nodeComparable.length,
    missing_go_capability_routes: routes.comparable.missing_in_go.map((route) => route.path),
    guards_not_endpoints: ['/v1/', '/v1beta/'],
    evidence_command: 'node scripts/collect-gateway-routes.js --json',
  };

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.route_baseline.collector_schema_version, 2);
  assert.deepEqual(manifest.route_baseline, expectedBaseline);
  assert.equal(manifest.source_revision.collection_script, 'scripts/collect-gateway-routes.js');
  assert.match(manifest.source_revision.git_commit, /^[0-9a-f]{40}$/u);

  for (const route of [...routes.node.routes, ...routes.go.routes]) {
    assertRouteEvidence(route);
  }
  assert.equal(nodeEndpoints.length, routes.node.endpoint_count);
  assert.equal(goEndpoints.length, routes.go.endpoint_count);
});

test('manifest 冻结生产 ownership，并把 Go Preview 隔离到专用端口', () => {
  assert.equal(manifest.public_endpoint.host, '127.0.0.1');
  assert.equal(manifest.public_endpoint.port, 9527);
  assert.equal(manifest.public_endpoint.production_owner, 'node');
  assert.equal(manifest.public_endpoint.migration_state, 'node_owned');
  assert.equal(manifest.public_endpoint.go_may_bind, false);

  assert.equal(manifest.go_private_endpoint.server.host, '127.0.0.1');
  assert.equal(manifest.go_private_endpoint.server.port, 19527);
  assert.equal(manifest.go_private_endpoint.web.host, '127.0.0.1');
  assert.equal(manifest.go_private_endpoint.web.port, 19528);
  assert.notEqual(manifest.go_private_endpoint.server.port, 9527);
  assert.notEqual(manifest.go_private_endpoint.web.port, 9527);
  assert.equal(manifest.go_private_endpoint.server.production, false);
  assert.equal(manifest.go_private_endpoint.web.production, false);
  assert.equal(manifest.go_private_endpoint.may_claim_public_9527, false);

  const ids = manifest.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'manifest entry id 必须唯一');
  for (const entry of manifest.entries) {
    assert.equal(entry.production_owner, 'node', entry.id);
    assert.equal(entry.migration_state, 'node_owned', entry.id);
    assert.ok(['route', 'capability_surface', 'preview_surface'].includes(entry.kind));
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, entry.id);
    for (const evidence of entry.evidence) {
      assert.equal(typeof evidence, 'string', entry.id);
      assert.equal(
        fs.existsSync(path.join(repositoryRoot, evidence)),
        true,
        `${entry.id} 的 evidence 不存在: ${evidence}`,
      );
    }
    for (const route of [...(entry.node_routes || []), ...(entry.go_routes || [])]) {
      assertManifestRouteSpec(route, entry.id);
    }
  }
});

test('Image Studio WebUI 路由以独立 Node capability surface 登记', () => {
  const entry = manifest.entries.find((candidate) => candidate.id === 'node.webui_image_studio');
  assert.ok(entry);
  assert.equal(entry.capability, 'durable_image_studio');
  assert.equal(entry.production_owner, 'node');
  assert.equal(entry.go_implementation, 'out_of_scope');
  assert.deepEqual(entry.node_routes, [
    { transport: 'http', methods: ['GET'], path: '/v0/webui/studio/image/models' },
    { transport: 'http', methods: ['GET', 'POST'], path: '/v0/webui/studio/image/sessions' },
    { transport: 'http', methods: ['DELETE', 'GET', 'PATCH'], path: '/v0/webui/studio/image/sessions/{sessionId}' },
    { transport: 'http', methods: ['POST'], path: '/v0/webui/studio/image/sessions/{sessionId}/runs' },
    { transport: 'http', methods: ['GET'], path: '/v0/webui/studio/image/sessions/{sessionId}/assets/{assetId}' },
  ]);

  const routes = collectGatewayRoutes().node.routes.filter((route) => [
    route.source,
    ...(route.sources || []),
  ].some((source) => source && source.file === 'lib/server/webui-image-studio-routes.js'));
  assert.deepEqual({
    routeRecords: routes.length,
    endpointRecords: routes.filter((route) => route.kind === 'endpoint').length,
    guardRecords: routes.filter((route) => route.kind === 'guard').length,
    uniqueEndpointPatterns: endpointPaths(routes).size,
  }, {
    routeRecords: 4,
    endpointRecords: 3,
    guardRecords: 1,
    uniqueEndpointPatterns: 3,
  });
});

test('v1/v1beta 作用域守卫不被登记为 endpoint', () => {
  const routes = collectGatewayRoutes();
  const guards = routes.node.routes.filter((route) => (
    route.path === '/v1/' || route.path === '/v1beta/'
  ));
  assert.deepEqual(
    guards.map((route) => route.kind),
    ['guard', 'guard'],
  );
  assert.equal(endpointPaths(routes.node.routes).has('/v1/'), false);
  assert.equal(endpointPaths(routes.node.routes).has('/v1beta/'), false);
  assert.deepEqual(manifest.route_baseline.guards_not_endpoints, ['/v1/', '/v1beta/']);
});

test('Gemini、image/blob、count_tokens 和 models detail 缺口在 manifest 中显式登记', () => {
  const routes = collectGatewayRoutes();
  assert.deepEqual(
    new Set(routes.comparable.missing_in_go.map((route) => route.path)),
    new Set(EXPECTED_MISSING_GO_PATHS),
  );

  for (const missingPath of EXPECTED_MISSING_GO_PATHS) {
    const entry = manifest.entries.find((candidate) => (
      (candidate.node_routes || []).some((route) => route.path === missingPath)
    ));
    assert.ok(entry, `manifest 未登记缺口: ${missingPath}`);
    assert.equal(entry.production_owner, 'node');
    assert.equal(entry.migration_state, 'node_owned');
    assert.equal(entry.cutover_blocking, true, missingPath);
    assert.deepEqual(entry.go_routes || [], [], missingPath);
  }
});
