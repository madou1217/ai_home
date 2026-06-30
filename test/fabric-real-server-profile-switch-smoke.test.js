'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_ALTERNATE_ENDPOINT,
  DEFAULT_ENDPOINT,
  buildReport,
  buildSetupUrl,
  normalizeHttpEndpoint,
  parseArgs,
  sanitizeProfile
} = require('../scripts/fabric-real-server-profile-switch-smoke');

test('server profile switch smoke parseArgs uses AWS default endpoints and default port', () => {
  const options = parseArgs([]);

  assert.equal(options.endpoint, DEFAULT_ENDPOINT);
  assert.equal(options.alternateEndpoint, DEFAULT_ALTERNATE_ENDPOINT);
  assert.equal(new URL(options.endpoint).port, '9527');
  assert.equal(new URL(options.alternateEndpoint).port, '9527');
  assert.equal(options.browserChannel, 'chrome');
});

test('server profile switch smoke parseArgs accepts explicit real endpoints and bundled browser', () => {
  const options = parseArgs([
    '--endpoint',
    'http://example.com:9527/',
    '--alternate-endpoint=http://192.0.2.10:9527/',
    '--timeout-ms',
    '120000',
    '--browser-channel',
    'bundled',
    '--diagnostics-file',
    '/tmp/aih-profile-switch.json'
  ]);

  assert.equal(options.endpoint, 'http://example.com:9527');
  assert.equal(options.alternateEndpoint, 'http://192.0.2.10:9527');
  assert.equal(options.timeoutMs, 120000);
  assert.equal(options.browserChannel, '');
  assert.equal(options.diagnosticsFile, '/tmp/aih-profile-switch.json');
});

test('server profile switch smoke parseArgs rejects invalid or duplicate endpoints', () => {
  assert.throws(() => normalizeHttpEndpoint('ws://example.com', '--endpoint'), /valid http\(s\) URL/);
  assert.throws(() => parseArgs([
    '--endpoint',
    'http://example.com:9527',
    '--alternate-endpoint',
    'http://example.com:9527'
  ]), /must be different URLs/);
  assert.throws(() => parseArgs(['--timeout-ms', '100']), /must be an integer/);
});

test('server profile switch smoke buildSetupUrl embeds pair URL without changing product port', () => {
  const setupUrl = buildSetupUrl(
    'http://example.com:9527',
    'http://example.com:9527/v0/fabric/device-pair?code=abc'
  );
  const parsed = new URL(setupUrl);

  assert.equal(parsed.origin, 'http://example.com:9527');
  assert.equal(parsed.pathname, '/ui/server-setup');
  assert.equal(parsed.searchParams.get('pair'), 'http://example.com:9527/v0/fabric/device-pair?code=abc');
});

test('server profile switch smoke sanitizes device tokens in diagnostics', () => {
  const sanitized = sanitizeProfile({
    id: 'cp-aws',
    name: 'AWS',
    endpoint: DEFAULT_ENDPOINT,
    connectionMode: 'direct',
    state: 'paired',
    authState: 'paired',
    deviceToken: 'secret-device-token',
    nodes: [{ id: 'aws-current-node', online: true, transportKinds: ['relay', 'webrtc'] }]
  });

  assert.equal(sanitized.deviceTokenPresent, true);
  assert.equal(sanitized.deviceTokenHash.length, 12);
  assert.equal('deviceToken' in sanitized, false);
  assert.deepEqual(sanitized.nodes[0].transportKinds, ['relay', 'webrtc']);
});

test('server profile switch smoke report records failure stage instead of opaque timeout', () => {
  const report = buildReport(parseArgs([]), {
    failure: { stage: 'webui_pair', code: 'paired_profile_missing_after_webui_pair' },
    finalSnapshot: { profiles: [], activeProfileId: '' },
    switchProofs: [],
    activeNodeInventory: null
  });

  assert.equal(report.ok, false);
  assert.ok(report.failures.some((item) => item.stage === 'webui_pair'));
  assert.ok(report.failures.some((item) => item.code === 'paired_profile_count_mismatch'));
});
