'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCodexProviderArgs } = require('../lib/cli/services/ai-cli/codex-provider-args');

test('codex provider args inject endpoint through config and keep the key in env', () => {
  const args = buildCodexProviderArgs({
    OPENAI_API_KEY: 'secret-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
  });

  assert.deepEqual(args, [
    '-c suppress_unstable_features_warning=true',
    '-c model_provider=aih_server',
    '-c model_providers.aih_server.base_url=http://127.0.0.1:9527/v1',
    '-c model_providers.aih_server.wire_api=responses',
    '-c model_providers.aih_server.env_key=OPENAI_API_KEY'
  ]);
  assert.equal(args.join(' ').includes('secret-key'), false);
});

test('codex provider args leave native OAuth config untouched', () => {
  assert.deepEqual(buildCodexProviderArgs({}), []);
});
