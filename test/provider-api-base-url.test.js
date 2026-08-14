const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveProviderApiBaseUrl,
  ownsProviderApiBaseUrl,
  GROK_DEFAULT_BASE_URL,
  KIRO_DEFAULT_BASE_URL
} = require('../lib/account/provider-api-base-url');
const { __private: upstreamPrivate } = require('../lib/server/upstream-endpoints');
const { __private: httpUtilsPrivate } = require('../lib/server/http-utils');

const OPTIONS = Object.freeze({
  codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
  claudeBaseUrl: 'https://api.anthropic.com/v1',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
});

test('provider api base url resolves grok/kimi/kiro and disowns everything else', () => {
  assert.equal(resolveProviderApiBaseUrl('grok', {}), GROK_DEFAULT_BASE_URL);
  assert.equal(resolveProviderApiBaseUrl('kiro', {}), KIRO_DEFAULT_BASE_URL);
  // kimi splits by credential kind: coding endpoint for OAuth, public API host
  // for a raw API key. 真实 ~/.kimi-code/config.toml 里就是 coding/v1。
  assert.equal(resolveProviderApiBaseUrl('kimi', {}), 'https://api.kimi.com/coding/v1');
  assert.equal(resolveProviderApiBaseUrl('kimi', { apiKeyMode: true }), 'https://api.moonshot.cn/v1');
  // 账号级覆盖优先，并去掉尾部斜杠。
  assert.equal(
    resolveProviderApiBaseUrl('grok', { openaiBaseUrl: 'https://relay.example.com/v1/' }),
    'https://relay.example.com/v1'
  );

  // 不归本模块管的 provider 必须返回 ''，绝不能借别家端点。
  ['codex', 'claude', 'gemini', 'agy', 'opencode', 'qoder', 'qodercn', 'nope'].forEach((provider) => {
    assert.equal(resolveProviderApiBaseUrl(provider, {}), '');
    assert.equal(ownsProviderApiBaseUrl(provider), false);
  });
});

test('no provider inherits the codex endpoint on either the chat or probe path', () => {
  // 这条是回归锁：两处 base URL 解析各写了一份，缺失的 provider 会落到
  // codexBaseUrl —— 于是 kimi 的模型探测被发去 chatgpt.com，报出来像是账号坏了。
  const resolveUpstream = upstreamPrivate.resolveProviderUpstream;
  const resolveBaseUrl = httpUtilsPrivate.resolveProviderBaseUrl;

  const expected = {
    codex: 'https://chatgpt.com/backend-api/codex',
    claude: 'https://api.anthropic.com/v1',
    grok: GROK_DEFAULT_BASE_URL,
    kimi: 'https://api.kimi.com/coding/v1',
    kiro: KIRO_DEFAULT_BASE_URL,
    opencode: '',
    qoder: '',
    qodercn: ''
  };

  Object.entries(expected).forEach(([provider, want]) => {
    const chat = resolveUpstream(OPTIONS, provider, {});
    const probe = resolveBaseUrl(OPTIONS, { provider });
    assert.equal(chat, want, `chat path for ${provider}`);
    assert.equal(probe, want, `probe path for ${provider}`);
    // 两条路径必须一致，否则聊天能通、探测却打错家。
    assert.equal(chat, probe, `chat/probe divergence for ${provider}`);
    if (provider !== 'codex') {
      assert.equal(chat.includes('chatgpt.com'), false, `${provider} must not inherit codex endpoint`);
    }
  });
});
