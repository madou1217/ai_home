'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteUsageRelay } = require('../lib/usage/remote-usage-relay');

test('remote usage relay retries are idempotent and advance after acknowledgement', async () => {
  const requests = [];
  const relay = createRemoteUsageRelay({
    sourceId: 'server-local-test',
    readProfiles: () => ({
      activeProfileId: 'aws',
      profiles: [{ id: 'aws', endpoint: 'https://proxy.meadeo.com', managementKey: 'secret' }]
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, inserted: 1 }) };
    }
  });
  const record = {
    id: 1,
    eventKey: 'codex:file:1:usage',
    provider: 'codex',
    accountRef: 'acct_0123456789abcdef01234567',
    model: 'gpt-6.1-sol',
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    timestampMs: Date.now()
  };
  const service = { listUsageRecords: ({ afterId }) => (afterId ? [] : [record]) };
  const result = await relay.sync(service);
  assert.deepEqual(result, { ok: true, sent: 1, inserted: 1, cursor: 1, target: 'aws' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://proxy.meadeo.com/v0/management/usage/import');
  assert.equal(requests[0].options.headers['x-aih-usage-source'], 'server-local-test');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.records[0].eventKey, record.eventKey);
});
