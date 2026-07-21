'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  handleSessionPreviewsRequest
} = require('../lib/server/webui-session-routes');

test('session previews return structured identities for equal ids across providers', async () => {
  let response;
  const sessions = [
    { provider: 'unknown-codex', id: 'native-1' },
    { provider: 'unknown-claude', id: 'native-1' }
  ];
  const handled = await handleSessionPreviewsRequest({
    req: {},
    res: {},
    deps: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({ sessions })),
    writeJson(_res, statusCode, payload) {
      response = { statusCode, payload };
    }
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.previews.map(({ provider, id }) => [provider, id]), [
    ['unknown-codex', 'native-1'],
    ['unknown-claude', 'native-1']
  ]);
});

test('AGY session previews prefer the recorded canonical model over a stale transcript label', async () => {
  let response;
  const handled = await handleSessionPreviewsRequest({
    req: {},
    res: {},
    deps: {
      readSessionLastModel: () => 'Gemini 3.5 Flash (Medium)',
      readSessionMessages: () => [{ role: 'assistant', content: 'done' }],
      modelUsageService: {
        getLastSessionModel: () => 'gemini-3.6-flash-tiered'
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      sessions: [{ provider: 'agy', id: 'session-1' }]
    })),
    writeJson(_res, statusCode, payload) {
      response = { statusCode, payload };
    }
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.previews[0].model, 'gemini-3.6-flash-tiered');
});
