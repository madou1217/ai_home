const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAUDE_CODE_SYSTEM_IDENTITY,
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystem,
  ensureClaudeCodeSystemBuffer,
  hasClaudeCodeIdentity,
  isNativeClaudeOAuthAccount
} = require('../lib/server/claude-official-client');

const OAUTH_ACCOUNT = { provider: 'claude' };
const AUTH_TOKEN_ACCOUNT = {
  provider: 'claude',
  credentialType: 'auth-token',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic'
};
const API_KEY_ACCOUNT = { provider: 'claude', apiKeyMode: true };

// 真实验收：同一账号同一时刻，原生 Claude Code 成功而网关重建的请求 429；
// 补齐官方身份后 /v1/messages 与 /v1/responses 双双 200。合同回退即再次不可用。
test('原生订阅 OAuth 才被判定为官方客户端通道', () => {
  assert.equal(isNativeClaudeOAuthAccount(OAUTH_ACCOUNT), true);
  assert.equal(isNativeClaudeOAuthAccount(AUTH_TOKEN_ACCOUNT), false);
  assert.equal(isNativeClaudeOAuthAccount(API_KEY_ACCOUNT), false);
  assert.equal(
    isNativeClaudeOAuthAccount({ provider: 'claude', baseUrl: 'https://relay.example' }),
    false
  );
  assert.equal(isNativeClaudeOAuthAccount({ provider: 'codex' }), false);
  assert.equal(isNativeClaudeOAuthAccount(null), false);
});

test('缺失身份时补到 system 最前，客户端自身内容原样保留', () => {
  const withArray = ensureClaudeCodeSystem({
    system: [{ type: 'text', text: '你是验收助手。' }]
  });
  assert.deepEqual(withArray.system, [
    { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY },
    { type: 'text', text: '你是验收助手。' }
  ]);

  const withString = ensureClaudeCodeSystem({ system: '纯文本 system' });
  assert.deepEqual(withString.system, [
    { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY },
    { type: 'text', text: '纯文本 system' }
  ]);

  const withoutSystem = ensureClaudeCodeSystem({ model: 'claude-opus-5' });
  assert.deepEqual(withoutSystem.system, [
    { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY }
  ]);
  assert.equal(withoutSystem.model, 'claude-opus-5');
});

test('已带身份的请求不被重复注入', () => {
  const body = {
    system: [
      { type: 'text', text: `${CLAUDE_CODE_SYSTEM_IDENTITY}\n\nCWD: /tmp` },
      { type: 'text', text: '官方客户端其余 system' }
    ]
  };
  assert.equal(hasClaudeCodeIdentity(body), true);
  assert.equal(ensureClaudeCodeSystem(body), body);
});

test('真实 Claude Code 请求保持逐字节透传', () => {
  const payload = JSON.stringify({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: `${CLAUDE_CODE_SYSTEM_IDENTITY}\n\nCWD: /tmp` }]
  });
  const buffer = Buffer.from(payload, 'utf8');
  assert.equal(ensureClaudeCodeSystemBuffer(buffer, OAUTH_ACCOUNT), buffer);
});

test('第三方端点与非 JSON 正文一律不改写', () => {
  const buffer = Buffer.from(JSON.stringify({ model: 'claude-opus-5' }), 'utf8');
  assert.equal(ensureClaudeCodeSystemBuffer(buffer, AUTH_TOKEN_ACCOUNT), buffer);
  assert.equal(ensureClaudeCodeSystemBuffer(buffer, API_KEY_ACCOUNT), buffer);

  const invalid = Buffer.from('not-json', 'utf8');
  assert.equal(ensureClaudeCodeSystemBuffer(invalid, OAUTH_ACCOUNT), invalid);
});

test('缺失身份的订阅 OAuth 请求被重写为带身份的正文', () => {
  const buffer = Buffer.from(
    JSON.stringify({ model: 'claude-opus-5', system: '客户端 system' }),
    'utf8'
  );
  const rewritten = ensureClaudeCodeSystemBuffer(buffer, OAUTH_ACCOUNT);
  assert.notEqual(rewritten, buffer);
  const parsed = JSON.parse(rewritten.toString('utf8'));
  assert.equal(parsed.system[0].text, CLAUDE_CODE_SYSTEM_IDENTITY);
  assert.equal(parsed.system[1].text, '客户端 system');
  assert.equal(parsed.model, 'claude-opus-5');
});

test('身份 Header 只补给订阅 OAuth，且不覆盖客户端自报值', () => {
  const fresh = {};
  applyClaudeCodeIdentityHeaders(fresh, OAUTH_ACCOUNT);
  assert.match(fresh['user-agent'], /^claude-cli\//);
  assert.equal(fresh['x-app'], 'cli');
  assert.equal(fresh['anthropic-dangerous-direct-browser-access'], 'true');

  // 真实 Claude Code 转发过来时自报版本比抓包快照更准确，必须保留。
  const forwarded = { 'user-agent': 'claude-cli/9.9.9 (external, sdk-cli)' };
  applyClaudeCodeIdentityHeaders(forwarded, OAUTH_ACCOUNT);
  assert.equal(forwarded['user-agent'], 'claude-cli/9.9.9 (external, sdk-cli)');

  const thirdParty = {};
  applyClaudeCodeIdentityHeaders(thirdParty, AUTH_TOKEN_ACCOUNT);
  assert.deepEqual(thirdParty, {});
});
