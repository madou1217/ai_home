const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getApiKeyDisplayName,
  getBaseDomain
} = require('../lib/server/account-display-identity');

test('getBaseDomain preserves explicit localhost ports', () => {
  assert.equal(getBaseDomain('http://127.0.0.1:9090/v1'), '127.0.0.1:9090');
  assert.equal(getBaseDomain('127.0.0.1:9090/v1'), '127.0.0.1:9090');
});

test('getApiKeyDisplayName keeps external local proxy port visible', () => {
  assert.equal(
    getApiKeyDisplayName('codex', { baseUrl: 'http://127.0.0.1:9090/v1' }),
    '127.0.0.1:9090'
  );
});

test('getApiKeyDisplayName still removes www prefix for remote hosts', () => {
  assert.equal(
    getApiKeyDisplayName('codex', { baseUrl: 'https://www.yeslaoban.com/llm/api/v1' }),
    'yeslaoban.com'
  );
});
