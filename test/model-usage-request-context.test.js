'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../lib/server/v1-router');

test('request context records only the safe dimensions needed by usage and error tables', () => {
  assert.equal(typeof __private.recordModelUsageRequestContext, 'function');
  const entries = [];
  const requestJson = {
    model: 'gpt-5.6-sol',
    stream: true,
    reasoning: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'private prompt' }],
    api_key: 'secret-key'
  };

  const recorded = __private.recordModelUsageRequestContext(
    (entry) => entries.push(entry),
    {
      requestMeta: {
        requestId: 'req-context-1',
        clientIp: '192.0.2.8'
      },
      requestJson,
      clientProtocol: 'openai_responses',
      method: 'POST',
      pathname: '/v1/responses'
    }
  );

  assert.equal(recorded, true);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(entries[0]).filter(([key]) => key !== 'at')),
    {
      kind: 'model_usage_request_context',
      requestId: 'req-context-1',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      endpoint: '/v1/responses',
      clientIp: '192.0.2.8',
      requestType: 'stream'
    }
  );
  assert.doesNotMatch(JSON.stringify(entries[0]), /private prompt|secret-key/);
});

test('request context derives Gemini path models and synchronous request type without inventing reasoning effort', () => {
  const entries = [];
  __private.recordModelUsageRequestContext((entry) => entries.push(entry), {
    requestMeta: { requestId: 'req-context-2', clientIp: '127.0.0.1' },
    requestJson: {},
    model: 'gemini-2.5-pro',
    clientProtocol: 'gemini_generate_content',
    method: 'POST',
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent'
  });

  assert.equal(entries[0].model, 'gemini-2.5-pro');
  assert.equal(entries[0].requestType, 'sync');
  assert.equal(entries[0].reasoningEffort, '');
});
