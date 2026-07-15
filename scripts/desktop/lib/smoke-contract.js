'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const CONTRACT_VERSION = 1;
const FIXTURE_PATHS = Object.freeze({
  health: '/healthz',
  json: '/v0/desktop-smoke/json',
  sse: '/v0/desktop-smoke/sse',
  blob: '/v0/desktop-smoke/blob',
});
const SMOKE_ENVIRONMENT = Object.freeze({
  mode: 'AIH_DESKTOP_SMOKE_MODE',
  runId: 'AIH_DESKTOP_SMOKE_RUN_ID',
  serverUrl: 'AIH_DESKTOP_SMOKE_SERVER_URL',
  managementKey: 'AIH_DESKTOP_SMOKE_MANAGEMENT_KEY',
  resultPath: 'AIH_DESKTOP_SMOKE_RESULT_PATH',
});
const BLOB_BYTES = Buffer.concat([
  Buffer.from('AIH desktop native blob fixture\n', 'utf8'),
  Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff]),
  Buffer.from('跨平台', 'utf8'),
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildExpectedFixture(runId) {
  return {
    json: {
      ok: true,
      runId,
      transport: 'rust-native',
      authorization: 'management-key',
    },
    sse: [
      { event: 'meta', data: { runId, sequence: 0 } },
      { event: 'delta', data: { sequence: 1, text: 'desktop-smoke' } },
      { event: 'delta', data: { sequence: 2, text: '跨平台' } },
      { event: 'done', data: { sequence: 3 } },
    ],
    blob: {
      bytes: BLOB_BYTES.length,
      sha256: sha256(BLOB_BYTES),
    },
  };
}

function platformKeyringBackend(platform) {
  const backends = {
    darwin: 'macos-keychain',
    linux: 'linux-secret-service',
    win32: 'windows-credential-manager',
  };
  return backends[platform] || null;
}

function canonicalPlatform(platform) {
  const platforms = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows',
  };
  return platforms[platform] || null;
}

function validateApplicationResult(result, context) {
  const errors = [];
  const expected = buildExpectedFixture(context.runId);
  const expectedBackend = platformKeyringBackend(context.platform);

  const check = (description, callback) => {
    try {
      callback();
    } catch (error) {
      errors.push(`${description}: ${error.message}`);
    }
  };

  check('schemaVersion', () => assert.equal(result.schemaVersion, CONTRACT_VERSION));
  check('runId', () => assert.equal(result.runId, context.runId));
  check('platform', () => assert.equal(result.platform, canonicalPlatform(context.platform)));
  check('keyring.backend', () => assert.equal(result.keyring?.backend, expectedBackend));
  for (const field of ['stored', 'readBack', 'deleted', 'missingAfterDelete']) {
    check(`keyring.${field}`, () => assert.equal(result.keyring?.[field], true));
  }
  check('http.json.status', () => assert.equal(result.http?.json?.status, 200));
  check('http.json.body', () => assert.deepEqual(result.http?.json?.body, expected.json));
  check('http.sse.status', () => assert.equal(result.http?.sse?.status, 200));
  check('http.sse.events', () => assert.deepEqual(result.http?.sse?.events, expected.sse));
  check('http.sse.completed', () => assert.equal(result.http?.sse?.completed, true));
  check('http.blob.status', () => assert.equal(result.http?.blob?.status, 200));
  check('http.blob.bytes', () => assert.equal(result.http?.blob?.bytes, expected.blob.bytes));
  check('http.blob.sha256', () => assert.equal(result.http?.blob?.sha256, expected.blob.sha256));

  return errors;
}

module.exports = {
  BLOB_BYTES,
  CONTRACT_VERSION,
  FIXTURE_PATHS,
  SMOKE_ENVIRONMENT,
  buildExpectedFixture,
  canonicalPlatform,
  platformKeyringBackend,
  validateApplicationResult,
};
