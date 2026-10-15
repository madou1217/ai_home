const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OFFICIAL_UPSTREAM_HOSTS,
  isCustomUpstreamAccount,
  isOfficialUpstreamEndpoint,
  isOfficialUpstreamHost,
  readUpstreamHost
} = require('../lib/account/official-upstream-endpoint');
const {
  CLINE_DEFAULT_BASE_URL,
  GROK_DEFAULT_BASE_URL,
  KIRO_DEFAULT_BASE_URL,
  ZCODE_DEFAULT_BASE_URL
} = require('../lib/account/provider-api-base-url');
const { KIMI_API_BASE_URL, KIMI_CODE_BASE_URL } = require('../lib/account/kimi-endpoints');
const { CODEBUDDY_FAMILY_INFERENCE_BASE_URLS } = require('../lib/account/codebuddy-family-inference');
const { getApiKeyDisplayName } = require('../lib/server/account-display-identity');

const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'contracts/providers/manifest.json');

function custom(provider, baseUrl, apiKeyMode = true) {
  return isCustomUpstreamAccount({ provider, apiKeyMode, baseUrl });
}

test('调度规则只对第三方/自建上游的 API Key 账号开放', () => {
  // 第三方反代（4router 这类 new-api 部署）→ 有可对齐的错误码。
  assert.equal(custom('codex', 'https://4router.net/v1'), true);
  // 官方地址（含子路径 / 端口 / 大小写 / 省略协议）→ 走厂商标准错误码。
  assert.equal(custom('codex', 'https://api.openai.com/v1'), false);
  assert.equal(custom('codex', 'https://api.openai.com'), false);
  assert.equal(custom('codex', 'api.openai.com/v1'), false);
  assert.equal(custom('codex', 'https://API.OPENAI.COM/v1'), false);
  assert.equal(custom('claude', 'https://api.anthropic.com/v1'), false);
  assert.equal(custom('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'), false);
  // 未配置 base URL → 官方默认端点。
  assert.equal(custom('codex', ''), false);
  assert.equal(custom('codex', null), false);
});

test('OAuth 登录态账号永远没有调度规则入口，即便配了自定义地址', () => {
  assert.equal(custom('codex', 'https://4router.net/v1', false), false);
  assert.equal(custom('claude', 'https://relay.example.com', false), false);
  assert.equal(custom('codex', '', false), false);
});

test('本机自建网关算第三方上游，官方主机表的子域命中官方', () => {
  // 自建 new-api / one-api 常跑在本机，正是最需要规则的一类上游。
  assert.equal(custom('codex', 'http://127.0.0.1:4000/v1'), true);
  assert.equal(custom('codex', 'http://localhost:3000/v1'), true);
  // 官方域的子域（www.codebuddy.ai）仍是官方。
  assert.equal(custom('codebuddy', 'https://www.codebuddy.ai'), false);
  assert.equal(custom('codebuddy', 'https://relay.other.ai'), true);
  assert.equal(isOfficialUpstreamHost('codebuddy', 'www.codebuddy.ai'), true);
  assert.equal(isOfficialUpstreamHost('codebuddy', 'notcodebuddy.ai'), false);
});

test('未登记官方主机表的 Provider 保守判为官方，配了但解析不出的地址算第三方', () => {
  // qoder/qodercn 是 CLI 桥接，没有可配置的自建上游 → 不给入口。
  assert.equal(custom('qoder', 'https://gateway.qoder.com.cn/model/v1'), false);
  assert.equal(custom('unknown-provider', 'https://relay.example.com/v1'), false);
  // 配了却解析不出主机：不是官方地址（否则等于静默关掉一个用户显式配置的入口）。
  assert.equal(custom('codex', 'http://'), true);
  assert.equal(readUpstreamHost('api.openai.com/v1'), 'api.openai.com');
  assert.equal(readUpstreamHost(''), '');
});

test('官方端点判定与「第三方上游」判定是同一份口径的互补', () => {
  assert.equal(isOfficialUpstreamEndpoint('codex', ''), true);
  assert.equal(isOfficialUpstreamEndpoint('codex', 'https://api.openai.com/v1'), true);
  assert.equal(isOfficialUpstreamEndpoint('codex', 'https://4router.net/v1'), false);
  assert.equal(isOfficialUpstreamEndpoint('codex', 'http://127.0.0.1:4000/v1'), false);
});

test('声明了 baseUrlEnv 的 Provider 必须显式登记官方主机，否则新增 Provider 会静默失去入口', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
  const withBaseUrlEnv = providers
    .filter((entry) => Array.isArray(entry.credentials && entry.credentials.baseUrlEnv)
      && entry.credentials.baseUrlEnv.length > 0)
    .map((entry) => String(entry.id || '').trim().toLowerCase())
    .filter(Boolean);
  assert.ok(withBaseUrlEnv.length >= 8, 'manifest 里应有多个可配置 base URL 的 Provider');
  for (const provider of withBaseUrlEnv) {
    assert.ok(
      Array.isArray(OFFICIAL_UPSTREAM_HOSTS[provider]) && OFFICIAL_UPSTREAM_HOSTS[provider].length > 0,
      `${provider} 声明了 baseUrlEnv，必须在 OFFICIAL_UPSTREAM_HOSTS 里登记官方主机`
    );
  }
});

test('官方主机表与运行时端点常量保持同源，端点改了这里必须跟着改', () => {
  // 默认域即官方主机（account-display-identity 的 DEFAULT_API_KEY_DOMAINS）。
  for (const provider of ['codex', 'claude', 'agy', 'gemini', 'opencode']) {
    const officialDomain = getApiKeyDisplayName(provider, {});
    assert.equal(
      isOfficialUpstreamHost(provider, officialDomain),
      true,
      `${provider} 的官方默认域 ${officialDomain} 未登记`
    );
  }
  const fromConstants = [
    ['grok', GROK_DEFAULT_BASE_URL],
    ['kiro', KIRO_DEFAULT_BASE_URL],
    ['cline', CLINE_DEFAULT_BASE_URL],
    ['zcode', ZCODE_DEFAULT_BASE_URL],
    ['kimi', KIMI_API_BASE_URL],
    ['kimi', KIMI_CODE_BASE_URL]
  ];
  for (const [provider, baseUrl] of fromConstants) {
    assert.equal(
      isOfficialUpstreamHost(provider, readUpstreamHost(baseUrl)),
      true,
      `${provider} 的默认端点 ${baseUrl} 未登记`
    );
  }
  for (const [provider, baseUrl] of Object.entries(CODEBUDDY_FAMILY_INFERENCE_BASE_URLS)) {
    assert.equal(
      isOfficialUpstreamHost(provider, readUpstreamHost(baseUrl)),
      true,
      `${provider} 的默认端点 ${baseUrl} 未登记`
    );
  }
});
