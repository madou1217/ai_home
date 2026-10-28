'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const manifest = require('../contracts/route-ownership/manifest.json');

function collect() {
  const output = execFileSync(process.execPath, ['scripts/collect-gateway-routes.js', '--json'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function summarize(payload) {
  const summary = {};
  for (const side of ['node', 'go']) {
    const routes = payload[side].routes || [];
    const endpoints = routes.filter((route) => route.kind === 'endpoint');
    const paths = (transport) => new Set(
      endpoints
        .filter((route) => !transport || route.transport === transport)
        .map((route) => route.path),
    ).size;
    summary[side] = {
      route_records: payload[side].total,
      endpoint_records: payload[side].endpoint_count,
      unique_endpoint_patterns: paths(),
      unique_http_endpoint_patterns: paths('http'),
      unique_websocket_endpoint_patterns: paths('websocket'),
      guard_records: payload[side].guard_count,
      fallback_records: payload[side].fallback_count,
    };
  }
  summary.comparable_node_http_endpoint_records = payload.comparable.node_endpoint_count;
  summary.missing_go_capability_routes = payload.comparable.missing_in_go;
  return summary;
}

test('route ownership manifest matches the current source scan', () => {
  const collected = collect();
  const baseline = manifest.route_baseline;
  assert.equal(collected.schema_version, baseline.collector_schema_version);
  assert.deepEqual(summarize(collected), {
    node: baseline.node,
    go: baseline.go,
    comparable_node_http_endpoint_records: baseline.comparable_node_http_endpoint_records,
    missing_go_capability_routes: baseline.missing_go_capability_routes,
  });
  assert.deepEqual(collected.comparable.missing_in_go, []);
});
