'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getManagedAihProviderBlock,
  removeAihManagedCruft,
  removeAihLegacyProviderSections,
  removeMigratedOpenaiBaseUrlScaffold
} = require('../lib/cli/services/pty/codex-config-sync');

const BS = String.fromCharCode(92);

test('遗留按账号命名的 aih provider 段被清理，aih_server 保留', () => {
  const config = [
    `[model_providers.aih_2]`,
    'name = "aih codex"',
    'base_url = "https://www.yeslaoban.com/llm/api/v1"',
    `bearer_token = "yesboss-plaintext"`,
    'wire_api = "responses"',
    '',
    '[model_providers.aih_server]',
    'name = "AIH Server"',
    'base_url = "https://www.yeslaoban.com/llm/api/v1"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
    '[model_providers.openai]',
    'name = "openai"'
  ].join('\n');
  const result = removeAihLegacyProviderSections(config);
  assert.equal(result.includes('aih_2'), false);
  assert.equal(result.includes('yesboss-plaintext'), false);
  assert.equal(result.includes('aih_server'), true);
  assert.equal(result.includes('model_providers.openai'), true);
});

test('迁移脚手架注释与其 openai_base_url 键成对清理，孤立注释亦清理', () => {
  const config = [
    '# This file is managed by ai-home (aih)',
    '',
    '# API endpoint configuration (migrated from OPENAI_BASE_URL env var)',
    'openai_base_url = "https://sub.jia4u.de/v1"',
    '',
    '# API endpoint configuration (migrated from OPENAI_BASE_URL env var)',
    'openai_base_url = "https://another-dead-relay/v1"',
    '',
    '# API endpoint configuration (migrated from OPENAI_BASE_URL env var)',
    'preferred_auth_method = "apikey"'
  ].join('\n');
  const result = removeMigratedOpenaiBaseUrlScaffold(config);
  assert.equal(result.includes('openai_base_url'), false);
  assert.equal(result.includes('migrated from OPENAI_BASE_URL'), false);
  // 注释后跟的不是 openai_base_url 时，只清注释、保留键
  assert.equal(result.includes('preferred_auth_method'), true);
});

test('用户自设的 openai_base_url（无脚手架标记）不被清理', () => {
  const config = [
    'openai_base_url = "https://my-own-relay.example/v1"',
    'model_provider = "openai"'
  ].join('\n');
  const result = removeMigratedOpenaiBaseUrlScaffold(config);
  assert.ok(result.includes('my-own-relay'));
});

test('removeAihManagedCruft 组合清理后受管块生成不再叠加遗留', () => {
  const dirty = [
    '# API endpoint configuration (migrated from OPENAI_BASE_URL env var)',
    'openai_base_url = "https://sub.jia4u.de/v1"',
    '',
    '[model_providers.aih_2]',
    'name = "aih codex"',
    `bearer_token = "yesboss-plaintext"`,
    'wire_api = "responses"',
    '',
    '[mcp_servers.blender]',
    `command = 'C:${BS}local${BS}bin${BS}uvx.exe'`
  ].join('\n');
  const cleaned = removeAihManagedCruft(dirty);
  assert.equal(cleaned.includes('aih_2'), false);
  assert.equal(cleaned.includes('openai_base_url'), false);
  assert.ok(cleaned.includes('mcp_servers.blender'));

  const block = getManagedAihProviderBlock({
    openaiBaseUrl: 'https://www.yeslaoban.com/llm/api/v1',
    openaiApiKey: 'secret-key'
  });
  assert.ok(block.includes('env_key = "OPENAI_API_KEY"'));
  assert.equal(block.includes('bearer_token'), false);
});
