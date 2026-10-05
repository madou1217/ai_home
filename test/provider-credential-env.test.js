'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  firstEnvValue,
  readProviderApiCredential,
  readProviderBaseUrl
} = require('../lib/account/provider-credential-env');

test('按合同优先级取第一个非空值：密钥优先于鉴权令牌，GEMINI 优先于 GOOGLE', () => {
  assert.equal(firstEnvValue({ A: ' ', B: 'b' }, ['A', 'B']), 'b');
  assert.equal(firstEnvValue(null, ['A']), '');
  assert.equal(readProviderApiCredential('claude', { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }), 'k');
  assert.equal(readProviderApiCredential('claude', { ANTHROPIC_AUTH_TOKEN: 't' }), 't');
  assert.equal(readProviderBaseUrl('gemini', { GOOGLE_BASE_URL: 'g', GEMINI_BASE_URL: 'm' }), 'm');
  assert.equal(readProviderBaseUrl('gemini', { GOOGLE_BASE_URL: 'g' }), 'g');
});

test('所有在合同里声明了凭据变量的 provider 都被识别（不再只认 codex/claude/gemini/kimi）', () => {
  assert.equal(readProviderApiCredential('grok', { XAI_API_KEY: 'x' }), 'x');
  assert.equal(readProviderApiCredential('zcode', { ZCODE_API_KEY: 'z' }), 'z');
  assert.equal(readProviderApiCredential('workbuddy', { CODEBUDDY_API_KEY: 'c' }), 'c');
  assert.equal(readProviderBaseUrl('kimi', { KIMI_BASE_URL: 'https://k' }), 'https://k');
  assert.equal(readProviderBaseUrl('opencode', { OPENCODE_BASE_URL: 'https://o' }), 'https://o');
  assert.equal(readProviderApiCredential('agy', { AGY_ACCESS_TOKEN: 'a' }), '', 'agy 没有密钥类凭据');
  assert.equal(readProviderApiCredential('unknown', { OPENAI_API_KEY: 'k' }), '', '未知 provider 不借用别家的变量');
});
