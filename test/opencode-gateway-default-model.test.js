'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickPreferredClaudeModel
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-gateway-default-model');

test('date snapshot suffixes do not count as version numbers', () => {
  assert.equal(pickPreferredClaudeModel(['claude-sonnet-4-20250514', 'claude-sonnet-4-6']), 'claude-sonnet-4-6');
  assert.equal(
    pickPreferredClaudeModel(['claude-opus-4-1-20250805', 'claude-opus-4-5-20251101', 'claude-opus-4-20250514']),
    'claude-opus-4-5-20251101'
  );
});

test('same version: the later date snapshot wins', () => {
  assert.equal(
    pickPreferredClaudeModel(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250101']),
    'claude-sonnet-4-5-20250929'
  );
});

test('family priority still applies before version (sonnet > opus > haiku)', () => {
  assert.equal(pickPreferredClaudeModel(['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']), 'claude-sonnet-4-6');
  assert.equal(pickPreferredClaudeModel(['claude-haiku-4-5-20251001', 'claude-opus-4-1']), 'claude-opus-4-1');
  assert.equal(pickPreferredClaudeModel([]), '');
});
