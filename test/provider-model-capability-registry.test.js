'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyGenerationConfigCapabilityStrategy,
  applyRequestParameterCapabilityStrategy,
  listAppliedGenerationConfigCapabilityRules,
  listAppliedRequestParameterCapabilityRules,
  listOmittedGenerationConfigKeys,
  listOmittedRequestParameterKeys
} = require('../lib/server/provider-model-capability-registry');

test('provider model capability registry omits Codex Responses unsupported request parameters', () => {
  const omitted = listOmittedRequestParameterKeys({
    provider: 'codex',
    protocol: 'openai_responses',
    model: 'gpt-5.5'
  });
  assert.deepEqual(omitted, ['temperature']);
  assert.deepEqual(listAppliedRequestParameterCapabilityRules({
    provider: 'codex',
    protocol: 'openai_responses',
    model: 'gpt-5.5'
  }).map((rule) => [rule.id, rule.omitKeys, rule.reason]), [[
    'codex:openai_responses:omit-temperature',
    ['temperature'],
    'codex_openai_responses_does_not_accept_temperature'
  ]]);

  const payload = applyRequestParameterCapabilityStrategy({
    model: 'gpt-5.5',
    temperature: 0.7,
    input: 'hello'
  }, {
    provider: 'codex',
    protocol: 'openai_responses',
    model: 'gpt-5.5'
  });

  assert.equal(Object.hasOwn(payload, 'temperature'), false);
  assert.equal(payload.model, 'gpt-5.5');
  assert.equal(payload.input, 'hello');
});

test('provider model capability registry omits AGY Claude Opus thinking generation temperature', () => {
  const dashed = listOmittedGenerationConfigKeys({
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'claude-opus-4.6-thinking',
    model: 'claude-opus-4.6-thinking'
  });
  const display = listOmittedGenerationConfigKeys({
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'Claude Opus 4.7 (Thinking)',
    model: 'Claude Opus 4.7 (Thinking)'
  });

  assert.deepEqual(dashed, ['temperature']);
  assert.deepEqual(display, ['temperature']);
  assert.deepEqual(listOmittedGenerationConfigKeys({
    provider: 'AGY',
    protocol: 'gemini_code_assist_stream_generate_content',
    originalModel: 'Claude Opus 5.1 Thinking',
    model: 'Claude Opus 5.1 Thinking'
  }), ['temperature']);
  assert.deepEqual(listAppliedGenerationConfigCapabilityRules({
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'claude-opus-4.6-thinking',
    model: 'claude-opus-4.6-thinking'
  }).map((rule) => [rule.id, rule.modelFamily, rule.omitKeys, rule.reason]), [[
    'agy:code_assist:claude_opus_thinking:omit-temperature',
    'claude_opus_thinking',
    ['temperature'],
    'agy_claude_opus_thinking_code_assist_does_not_accept_generation_temperature'
  ]]);

  const generationConfig = applyGenerationConfigCapabilityStrategy({
    maxOutputTokens: 512,
    temperature: 0.2,
    topP: 0.9
  }, {
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'Claude Opus 4.7 (Thinking)',
    model: 'Claude Opus 4.7 (Thinking)'
  });

  assert.equal(Object.hasOwn(generationConfig, 'temperature'), false);
  assert.equal(generationConfig.maxOutputTokens, 512);
  assert.equal(generationConfig.topP, 0.9);
});

test('provider model capability registry keeps unrelated generation temperature', () => {
  assert.deepEqual(listOmittedGenerationConfigKeys({
    provider: 'gemini',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'claude-opus-4.6-thinking'
  }), []);

  assert.deepEqual(listOmittedGenerationConfigKeys({
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'claude-sonnet-4.6-thinking'
  }), []);

  assert.deepEqual(listOmittedGenerationConfigKeys({
    provider: 'agy',
    protocol: 'openai_responses',
    originalModel: 'Claude Opus 5.1 Thinking'
  }), []);

  const generationConfig = applyGenerationConfigCapabilityStrategy({
    temperature: 0.4
  }, {
    provider: 'agy',
    protocol: 'gemini_code_assist_generate_content',
    originalModel: 'claude-sonnet-4.6-thinking'
  });

  assert.equal(generationConfig.temperature, 0.4);
});
