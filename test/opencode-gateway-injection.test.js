const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  opencodeStrategy,
  resolveHealthyGatewayModels,
  buildGatewayConfig,
  resolveGatewayProfile
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

test('upstream failure policy: distinguishes OpenCode FreeUsageLimitError (model scope) from GoUsageLimitError (account scope)', () => {
  const freePolicy = classifyUpstreamFailure({
    provider: 'opencode',
    statusCode: 429,
    detail: 'HTTP 429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Please wait a few minutes."}}'
  });
  assert.equal(freePolicy.kind, 'rate_limited');
  assert.equal(freePolicy.scope, 'model');
  assert.equal(freePolicy.shouldRetryAnotherAccount, true);

  const goPolicy = classifyUpstreamFailure({
    provider: 'opencode',
    statusCode: 429,
    detail: 'HTTP 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached. Resets in 13 days"}}'
  });
  assert.equal(goPolicy.kind, 'account_usage_exhausted');
  assert.equal(goPolicy.scope, 'account');
});

test('upstream failure policy: classifies OpenCode CreditsError (401/402/403) without poison 1-year auth_invalid lock', () => {
  const creditsPolicy = classifyUpstreamFailure({
    provider: 'opencode',
    statusCode: 401,
    detail: 'HTTP 401 {"type":"error","error":{"type":"CreditsError","message":"You have no credits. Visit https://opencode.ai/workspace/wrk_12345/billing to add credits."}}'
  });
  assert.equal(creditsPolicy.kind, 'model_entitlement_required');
  assert.equal(creditsPolicy.scope, 'model');
  assert.notEqual(creditsPolicy.kind, 'auth_invalid');
});

test('opencode launch strategy: dynamically generates BYOK gateway config with healthy models', () => {
  const mockCtx = {
    baseEnv: {
      AIH_OPENCODE_GATEWAY_BASE_URL: 'http://127.0.0.1:9527/v1',
      AIH_OPENCODE_GATEWAY_KEY: 'test-key'
    },
    hostHomeDir: os.tmpdir(),
    sandboxDir: os.tmpdir(),
    path: path
  };

  const profile = resolveGatewayProfile(mockCtx);
  assert.ok(profile);
  assert.equal(profile.baseUrl, 'http://127.0.0.1:9527/v1');
  assert.equal(profile.apiKey, 'test-key');

  const config = buildGatewayConfig(profile, mockCtx);
  assert.ok(config.provider);
  assert.ok(config.provider.aih);
  assert.equal(config.provider.aih.options.baseURL, 'http://127.0.0.1:9527/v1');
  assert.equal(config.provider.aih.options.apiKey, 'test-key');
  assert.ok(Object.keys(config.provider.aih.models).length > 0);

  const envPatch = opencodeStrategy.buildEnvPatch(mockCtx);
  assert.ok(envPatch.set.OPENCODE_CONFIG_CONTENT);
  const parsed = JSON.parse(envPatch.set.OPENCODE_CONFIG_CONTENT);
  assert.equal(parsed.provider.aih.options.baseURL, 'http://127.0.0.1:9527/v1');
});
