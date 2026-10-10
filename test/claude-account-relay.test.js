'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  shouldRelayClaudeAccount
} = require('../lib/cli/services/ai-cli/claude-account-relay');
const { claudeRelayProfile } = require('../lib/cli/services/ai-cli/relay/claude-relay-profile');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

test('Claude native OAuth accounts relay through the gateway by accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: ACCOUNT_REF,
    accountEnv: {}
  }), true);

  assert.deepEqual(buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF), {
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
    ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
  });
});

test('Claude relay is disabled for gateway and login modes', () => {
  const base = { provider: 'claude', accountRef: ACCOUNT_REF, accountEnv: {} };
  assert.equal(shouldRelayClaudeAccount({ ...base, gateway: true }), false);
  assert.equal(shouldRelayClaudeAccount({ ...base, isLogin: true }), false);
});

test('Claude API key and auth token accounts relay through the gateway by accountRef', () => {
  const base = { provider: 'claude', accountRef: ACCOUNT_REF };
  assert.equal(shouldRelayClaudeAccount({ ...base, accountEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } }), true);
  assert.equal(shouldRelayClaudeAccount({ ...base, accountEnv: { ANTHROPIC_AUTH_TOKEN: 'direct-token' } }), true);
});

test('Claude relay rejects mutable CLI ids and accepts only accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: '9',
    accountEnv: {}
  }), false);
  assert.throws(
    () => buildClaudeAccountRelayEnv({}, '9'),
    /invalid_claude_relay_account_ref/
  );
});

test('aih Claude launches hand the gateway address and pin to --settings so host settings cannot hijack them', () => {
  const relayEnv = buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF);
  const args = buildClaudeLaunchSettingsArgs(relayEnv, ['-p', 'hi']);
  assert.equal(args[0], '--settings');
  assert.deepEqual(JSON.parse(args[1]), {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
      ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
    }
  });
  assert.doesNotMatch(args[1], /gateway-key/, 'argv 对本机可见，不能带密钥');

  // 不钉选的 AIH Server 启动显式清空钉选头，宿主默认的钉选不会被继承。
  const gatewayArgs = buildClaudeLaunchSettingsArgs({ ANTHROPIC_API_KEY: 'gateway-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' });
  assert.equal(JSON.parse(gatewayArgs[1]).env.ANTHROPIC_CUSTOM_HEADERS, '');

  assert.deepEqual(buildClaudeLaunchSettingsArgs({}), [], '没有网关地址时不整形');
  assert.deepEqual(buildClaudeLaunchSettingsArgs(relayEnv, ['--settings', '/tmp/x.json']), [], '用户自带 --settings 时不覆盖');
  assert.deepEqual(buildClaudeLaunchSettingsArgs(relayEnv, ['--settings=/tmp/x.json']), []);
});

test('the Claude relay profile prefixes --settings for every non-login launch', () => {
  const accountEnv = buildClaudeAccountRelayEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' }, ACCOUNT_REF);
  const launch = claudeRelayProfile.buildRelayLaunch({ args: ['--resume', 'abc'], accountEnv, isLogin: false });
  assert.equal(launch.args[0], '--settings');
  assert.deepEqual(launch.args.slice(2), ['--resume', 'abc']);
  assert.equal(claudeRelayProfile.buildRelayLaunch({ args: [], accountEnv, isLogin: true }), null);
  assert.equal(claudeRelayProfile.buildRelayLaunch({ args: [], accountEnv: {}, isLogin: false }), null);
});
