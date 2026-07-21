'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  applyAgyUsageSnapshotToAccount
} = require('../lib/server/agy-usage-snapshot');
const {
  __private: httpPrivate
} = require('../lib/server/http-utils');

function createTrustedUsageSnapshot(project) {
  return {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: 1_750_000_000_000,
    account: {
      project
    },
    models: [{
      model: 'claude-opus-4-6-thinking',
      remainingPct: 80,
      resetAtMs: 1_750_003_600_000
    }]
  };
}

test('inference health-checks the project restored from a trusted AGY usage snapshot', async (t) => {
  let requestBody = null;
  t.mock.method(global, 'fetch', async (_url, init = {}) => {
    requestBody = JSON.parse(String(init.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        cloudaicompanionProject: 'projects/usage-verified'
      })
    };
  });

  const account = {
    provider: 'agy',
    accessToken: 'agy-token'
  };
  applyAgyUsageSnapshotToAccount(account, createTrustedUsageSnapshot('projects/usage-verified'));

  const project = await httpPrivate.fetchGeminiCodeAssistProject({
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
  }, account, 500);

  assert.equal(project, 'projects/usage-verified');
  assert.equal(account.codeAssistProject, 'projects/usage-verified');
  assert.equal(requestBody.cloudaicompanionProject, 'projects/usage-verified');
  assert.equal(requestBody.metadata.duetProject, 'projects/usage-verified');
  assert.equal(requestBody.mode, 'HEALTH_CHECK');
});

test('loadCodeAssist decodes a gzip JSON project response', async (t) => {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({
    cloudaicompanionProject: 'projects/gzip-project'
  })));
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-encoding', 'gzip']]),
    arrayBuffer: async () => compressed
  }));

  const account = {
    provider: 'agy',
    accessToken: 'agy-token'
  };
  const project = await httpPrivate.fetchGeminiCodeAssistProject({
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
  }, account, 500);

  assert.equal(project, 'projects/gzip-project');
  assert.equal(account.codeAssistProject, 'projects/gzip-project');
});
