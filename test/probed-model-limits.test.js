'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasProbedModelLimits,
  registerProbedModelLimits,
  resetProbedModelLimits,
  resolveProbedContextLength,
  restoreProbedModelLimits,
  snapshotProbedModelLimits
} = require('../lib/server/probed-model-limits');

test.beforeEach(() => resetProbedModelLimits());

test('probe registration reads the context field names OpenAI-compatible servers use', () => {
  registerProbedModelLimits('acct_local', [
    { id: 'qwen3.8-27b', context_length: 262144, max_model_len: 262144 },
    { id: 'vllm-model', max_model_len: 32768 },
    { id: 'lmstudio-model', max_context_length: 8192 },
    { id: 'plain-model' }
  ], ['qwen3.8-27b', 'vllm-model', 'lmstudio-model', 'plain-model']);

  assert.equal(resolveProbedContextLength('acct_local', 'qwen3.8-27b'), 262144);
  assert.equal(resolveProbedContextLength('acct_local', 'vllm-model'), 32768);
  assert.equal(resolveProbedContextLength('acct_local', 'lmstudio-model'), 8192);
  assert.equal(resolveProbedContextLength('acct_local', 'plain-model'), 0);
});

test('probe registration ignores models the probe filtered out and invalid lengths', () => {
  registerProbedModelLimits('acct_relay', [
    { id: 'kept', context_length: 128000 },
    { id: 'filtered/partner', context_length: 64000 },
    { id: 'bogus', context_length: -1 }
  ], ['kept', 'bogus']);

  assert.deepEqual(snapshotProbedModelLimits('acct_relay'), { kept: 128000 });
});

test('a successful probe without context fields still marks the account as probed', () => {
  assert.equal(hasProbedModelLimits('acct_openai'), false);
  registerProbedModelLimits('acct_openai', [{ id: 'gpt-x' }], ['gpt-x']);
  assert.equal(hasProbedModelLimits('acct_openai'), true);
  assert.deepEqual(snapshotProbedModelLimits('acct_openai'), {});
});

test('restoring a persisted snapshot never overwrites a fresher probe in this process', () => {
  registerProbedModelLimits('acct_local', [{ id: 'qwen3.8-27b', context_length: 262144 }], ['qwen3.8-27b']);
  restoreProbedModelLimits('acct_local', { 'qwen3.8-27b': 131072 });
  assert.equal(resolveProbedContextLength('acct_local', 'qwen3.8-27b'), 262144);

  restoreProbedModelLimits('acct_restarted', { 'qwen3.8-27b': 262144, broken: 'n/a' });
  assert.deepEqual(snapshotProbedModelLimits('acct_restarted'), { 'qwen3.8-27b': 262144 });
});
