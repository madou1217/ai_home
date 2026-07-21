const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyAliasCandidate,
  resolveModelAliasCandidates,
  resolveModelAliasRequest,
  resolveProtocolAliasBaseProvider
} = require('../lib/server/model-alias-resolver');

test('model-alias-resolver: returns empty resolution when request has no model', () => {
  const requestJson = { messages: [] };
  const result = resolveModelAliasRequest({
    aliases: [{
      id: 'unused',
      alias: 'gpt-5.5',
      target: 'claude-opus-4.6-thinking',
      provider: 'all',
      enabled: true
    }],
    requestJson
  });

  assert.equal(result.changed, false);
  assert.equal(result.requestJson, requestJson);
  assert.equal(result.aliasTargetProvider, '');
  assert.equal(result.preferModelRouting, false);
  assert.deepEqual(result.aliasResolution, {
    requestedModel: '',
    effectiveModel: '',
    aliasMatched: false,
    aliasId: '',
    aliasTarget: '',
    aliasScopeProvider: '',
    aliasTargetProvider: '',
    effectiveProvider: ''
  });
});

test('model-alias-resolver: auto target provider rewrites model and keeps model routing preferred', () => {
  const requestJson = { model: 'gpt-5.5', messages: [] };
  const result = resolveModelAliasRequest({
    aliases: [{
      id: 'gpt55-to-agy-claude',
      alias: 'gpt-5.5',
      target: 'claude-opus-4.6-thinking',
      provider: 'codex',
      targetProvider: 'auto',
      enabled: true
    }],
    requestJson,
    resolveRequestProvider: () => 'codex'
  });

  assert.equal(result.changed, true);
  assert.notEqual(result.requestJson, requestJson);
  assert.equal(result.requestJson.model, 'claude-opus-4.6-thinking');
  assert.equal(result.aliasTargetProvider, '');
  assert.equal(result.preferModelRouting, true);
  assert.equal(result.aliasResolution.aliasMatched, true);
  assert.equal(result.aliasResolution.aliasId, 'gpt55-to-agy-claude');
  assert.equal(result.aliasResolution.requestedModel, 'gpt-5.5');
  assert.equal(result.aliasResolution.effectiveModel, 'claude-opus-4.6-thinking');
  assert.equal(result.aliasResolution.effectiveProvider, '');
});

test('model-alias-resolver: explicit target provider pins upstream provider', () => {
  const result = resolveModelAliasRequest({
    aliases: [{
      id: 'claude-to-codex',
      alias: 'claude-opus-4.6-thinking',
      target: 'gpt-5.5',
      provider: 'claude',
      targetProvider: 'codex',
      enabled: true
    }],
    requestJson: { model: 'claude-opus-4.6-thinking', messages: [] },
    clientProtocol: 'anthropic_messages',
    resolveRequestProvider: () => 'agy'
  });

  assert.equal(result.changed, true);
  assert.equal(result.requestJson.model, 'gpt-5.5');
  assert.equal(result.aliasTargetProvider, 'codex');
  assert.equal(result.preferModelRouting, false);
  assert.equal(result.aliasResolution.aliasTargetProvider, 'codex');
  assert.equal(result.aliasResolution.effectiveProvider, 'codex');
});

test('model-alias-resolver: anthropic protocol uses claude as alias scope provider', () => {
  const result = resolveModelAliasRequest({
    aliases: [{
      id: 'anthropic-scope',
      alias: 'gpt-5.5',
      target: 'claude-opus-4.6-thinking',
      provider: 'claude',
      enabled: true
    }],
    requestJson: { model: 'gpt-5.5' },
    clientProtocol: 'anthropic_messages',
    resolveRequestProvider: () => 'codex'
  });

  assert.equal(result.baseProvider, 'claude');
  assert.equal(result.changed, true);
  assert.equal(result.aliasResolution.aliasId, 'anthropic-scope');
});

test('model-alias-resolver: gemini protocol uses gemini as alias scope provider', () => {
  const result = resolveModelAliasRequest({
    aliases: [{
      id: 'gemini-scope',
      alias: 'gpt-5.5',
      target: 'gemini-3.5-flash-high',
      provider: 'gemini',
      enabled: true
    }],
    requestJson: { model: 'gpt-5.5' },
    clientProtocol: 'gemini_generate_content',
    resolveRequestProvider: () => 'codex'
  });

  assert.equal(result.baseProvider, 'gemini');
  assert.equal(result.changed, true);
  assert.equal(result.aliasResolution.aliasId, 'gemini-scope');
});

test('model-alias-resolver: resolveModelAliasCandidates returns priority-ordered candidates', () => {
  const aliases = [
    {
      id: 'low',
      alias: 'claude-*',
      target: 'gemini-3.5-flash-low',
      provider: 'all',
      priority: 0,
      enabled: true
    },
    {
      id: 'high',
      alias: 'claude-*',
      target: 'claude-opus-4-6-thinking',
      provider: 'all',
      priority: 10,
      enabled: true
    }
  ];
  const result = resolveModelAliasCandidates({
    aliases,
    requestJson: { model: 'claude-sonnet-4-6' },
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.requestedModel, 'claude-sonnet-4-6');
  assert.equal(result.baseProvider, 'claude');
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['high', 'low']);
});

test('model-alias-resolver: applyAliasCandidate rewrites model and records priority', () => {
  const requestJson = { model: 'claude-sonnet-4-6', messages: [] };
  const result = applyAliasCandidate({
    requestJson,
    candidate: {
      id: 'high',
      alias: 'claude-*',
      target: 'claude-opus-4-6-thinking',
      provider: 'all',
      targetProvider: 'agy',
      priority: 10
    },
    baseProvider: 'claude'
  });

  assert.equal(result.changed, true);
  assert.equal(result.requestJson.model, 'claude-opus-4-6-thinking');
  assert.equal(result.aliasTargetProvider, 'agy');
  assert.equal(result.aliasResolution.aliasMatched, true);
  assert.equal(result.aliasResolution.aliasPriority, 10);
  assert.equal(result.baseProvider, 'claude');
});

test('model-alias-resolver: applyAliasCandidate without candidate keeps request unchanged', () => {
  const requestJson = { model: 'claude-sonnet-4-6' };
  const result = applyAliasCandidate({ requestJson, candidate: null, baseProvider: 'claude' });

  assert.equal(result.changed, false);
  assert.equal(result.requestJson, requestJson);
  assert.equal(result.aliasResolution.aliasMatched, false);
});

test('model-alias-resolver: fallback scope comes from request provider resolver', () => {
  const result = resolveProtocolAliasBaseProvider({
    requestJson: { model: 'gpt-5.5' },
    resolveRequestProvider: () => 'agy'
  });

  assert.equal(result, 'agy');
});
