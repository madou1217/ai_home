const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { claudeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/claude-strategy');
const {
  isOfficialAnthropicBaseUrl,
  shouldDisableAdvisorForBaseUrl
} = require('../lib/account/anthropic-endpoint');

function buildCtx(baseEnv) {
  return {
    sandboxDir: '/tmp/sandbox',
    path,
    isLogin: false,
    baseEnv: baseEnv || {}
  };
}

test('isOfficialAnthropicBaseUrl recognizes only the official endpoint', () => {
  assert.equal(isOfficialAnthropicBaseUrl('https://api.anthropic.com'), true);
  assert.equal(isOfficialAnthropicBaseUrl('https://api.anthropic.com/v1'), true);
  assert.equal(isOfficialAnthropicBaseUrl('https://API.Anthropic.com/'), true);
  assert.equal(isOfficialAnthropicBaseUrl('https://api.deepseek.com/anthropic'), false);
  assert.equal(isOfficialAnthropicBaseUrl(''), false);
});

test('shouldDisableAdvisorForBaseUrl: only explicit non-official, non-loopback endpoints', () => {
  // Direct third-party endpoints — advisor must be disabled.
  assert.equal(shouldDisableAdvisorForBaseUrl('https://api.deepseek.com/anthropic'), true);
  assert.equal(shouldDisableAdvisorForBaseUrl('https://open.bigmodel.cn/api/anthropic'), true);
  // Official endpoint — keep advisor.
  assert.equal(shouldDisableAdvisorForBaseUrl('https://api.anthropic.com/v1'), false);
  // Empty / unparseable — official OAuth account carries no base URL, keep advisor.
  assert.equal(shouldDisableAdvisorForBaseUrl(''), false);
  assert.equal(shouldDisableAdvisorForBaseUrl(undefined), false);
  assert.equal(shouldDisableAdvisorForBaseUrl('not a url'), false);
  // Loopback = self-relay through the local aih gateway (port 9527); advisor is
  // handled there. Port-agnostic — any loopback host keeps advisor.
  assert.equal(shouldDisableAdvisorForBaseUrl('http://127.0.0.1:9527'), false);
  assert.equal(shouldDisableAdvisorForBaseUrl('http://localhost:9527'), false);
  assert.equal(shouldDisableAdvisorForBaseUrl('http://0.0.0.0:9527'), false);
});

test('buildEnvPatch disables advisor for a DeepSeek (third-party, strict) endpoint', () => {
  const patch = claudeStrategy.buildEnvPatch(buildCtx({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-test'
  }));
  assert.equal(patch.set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
  assert.ok(patch.set.CLAUDE_CONFIG_DIR);
});

test('buildEnvPatch disables advisor for a GLM endpoint (inert there, harmless)', () => {
  const patch = claudeStrategy.buildEnvPatch(buildCtx({
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic'
  }));
  assert.equal(patch.set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
});

test('buildEnvPatch keeps advisor for the explicit official endpoint', () => {
  const patch = claudeStrategy.buildEnvPatch(buildCtx({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
  }));
  assert.equal(patch.set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
});

test('buildEnvPatch keeps advisor when no base URL is set (official OAuth account)', () => {
  const patch = claudeStrategy.buildEnvPatch(buildCtx({}));
  assert.equal(patch.set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
  assert.ok(patch.set.CLAUDE_CONFIG_DIR);
});

test('buildEnvPatch keeps advisor for a self-relay (loopback gateway) account', () => {
  const patch = claudeStrategy.buildEnvPatch(buildCtx({
    ANTHROPIC_API_KEY: 'aih_client_x',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }));
  assert.equal(patch.set.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
});

test('buildEnvPatch unsets USER on normal launch and not on login', () => {
  assert.deepEqual(claudeStrategy.buildEnvPatch(buildCtx({})).unset, ['USER']);
  const loginPatch = claudeStrategy.buildEnvPatch({ ...buildCtx({}), isLogin: true });
  assert.deepEqual(loginPatch.unset, []);
});
