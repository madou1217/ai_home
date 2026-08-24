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
      provider: '',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      endpoint: '/v1/responses',
      clientIp: '192.0.2.8',
      requestType: 'stream'
    }
  );
  assert.doesNotMatch(JSON.stringify(entries[0]), /private prompt|secret-key/);
});

test('request context derives Gemini path models and marks omitted reasoning as provider default', () => {
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
  assert.equal(entries[0].reasoningEffort, 'provider_default');
});

test('request context preserves Anthropic and Gemini thinking controls without guessing an effort level', () => {
  const entries = [];
  const appendLog = (entry) => entries.push(entry);

  __private.recordModelUsageRequestContext(appendLog, {
    requestMeta: { requestId: 'req-context-anthropic', clientIp: '192.0.2.10' },
    requestJson: {
      model: 'claude-opus-4-8',
      thinking: { type: 'enabled', budget_tokens: 8000 }
    },
    provider: 'claude',
    clientProtocol: 'anthropic_messages',
    method: 'POST',
    pathname: '/v1/messages'
  });
  __private.recordModelUsageRequestContext(appendLog, {
    requestMeta: { requestId: 'req-context-gemini-level', clientIp: '192.0.2.11' },
    requestJson: {
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }
    },
    model: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    clientProtocol: 'gemini_generate_content',
    method: 'POST',
    pathname: '/v1beta/models/gemini-3.1-pro-preview:generateContent'
  });
  __private.recordModelUsageRequestContext(appendLog, {
    requestMeta: { requestId: 'req-context-gemini-budget', clientIp: '192.0.2.12' },
    requestJson: {
      generation_config: { thinking_config: { thinking_budget: -1 } }
    },
    model: 'gemini-2.5-pro',
    provider: 'gemini',
    clientProtocol: 'gemini_generate_content',
    method: 'POST',
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent'
  });

  assert.equal(entries[0].provider, 'claude');
  assert.equal(entries[0].reasoningEffort, 'budget:8000');
  assert.equal(entries[1].provider, 'gemini');
  assert.equal(entries[1].reasoningEffort, 'high');
  assert.equal(entries[2].provider, 'gemini');
  assert.equal(entries[2].reasoningEffort, 'budget:-1');
});

test('request context does not coerce empty thinking budgets into disabled reasoning', () => {
  const entries = [];
  const appendLog = (entry) => entries.push(entry);

  __private.recordModelUsageRequestContext(appendLog, {
    requestMeta: { requestId: 'req-context-empty-anthropic-budget' },
    requestJson: {
      model: 'claude-opus-4-8',
      thinking: { type: 'enabled', budget_tokens: null }
    },
    method: 'POST',
    pathname: '/v1/messages'
  });
  __private.recordModelUsageRequestContext(appendLog, {
    requestMeta: { requestId: 'req-context-empty-gemini-budget' },
    requestJson: {
      generationConfig: {
        thinkingConfig: { thinkingBudget: '', includeThoughts: false }
      }
    },
    method: 'POST',
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent'
  });

  assert.equal(entries[0].reasoningEffort, 'enabled');
  assert.equal(entries[1].reasoningEffort, 'disabled');
});

test('request context gives the local model catalog explicit non-inference semantics', () => {
  const entries = [];
  __private.recordModelUsageRequestContext((entry) => entries.push(entry), {
    requestMeta: { requestId: 'req-context-models', clientIp: '127.0.0.1' },
    requestJson: {},
    provider: 'gateway',
    clientProtocol: 'openai_models',
    method: 'GET',
    pathname: '/v1/models'
  });

  assert.equal(entries[0].provider, 'gateway');
  assert.equal(entries[0].model, 'model-catalog');
  assert.equal(entries[0].reasoningEffort, 'not_applicable');
  assert.equal(entries[0].requestType, 'sync');
});
