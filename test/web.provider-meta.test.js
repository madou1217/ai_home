'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sharedCatalog = require('../lib/provider-catalog');

// readGeneratedClientDefinitions 从生成文件中提取纯 JSON 定义，不执行浏览器代码。
function readGeneratedClientDefinitions() {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'providers',
    'provider-contract.generated.ts'
  ), 'utf8');
  const match = source.match(/export const PROVIDER_DEFINITIONS = ([\s\S]*?) as const;/);
  assert.ok(match, '无法从 TypeScript 生成文件读取 Provider 定义');
  return JSON.parse(match[1]);
}

test('Provider 展示元数据为归档会话提供稳定名称和颜色', () => {
  assert.equal(sharedCatalog.getProviderMeta('codex').label, 'ChatGPT');
  assert.equal(sharedCatalog.getProviderMeta('claude').label, 'Claude');
  assert.equal(sharedCatalog.getProviderMeta('gemini').label, 'Gemini');
  assert.equal(sharedCatalog.getProviderMeta('agy').label, 'Antigravity');
  assert.equal(sharedCatalog.getProviderMeta('opencode').label, 'OpenCode');
  assert.equal(sharedCatalog.getProviderMeta('codex').tagColor, 'green');
  assert.equal(sharedCatalog.getProviderMeta('claude').tagColor, 'orange');
  assert.equal(sharedCatalog.getProviderMeta('gemini').tagColor, 'blue');
  assert.equal(sharedCatalog.getProviderMeta('agy').tagColor, 'purple');
  assert.equal(sharedCatalog.getProviderMeta('opencode').tagColor, 'default');
});

test('Server 与 TypeScript Client Provider 投影保持一致', () => {
  const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');
  const clientDefinitions = readGeneratedClientDefinitions();
  const clientIds = clientDefinitions.map((definition) => definition.id);

  assert.deepEqual(clientIds, sharedCatalog.listProviderIds());
  assert.deepEqual(SUPPORTED_SERVER_PROVIDERS, sharedCatalog.listProviderIds());
  assert.equal(clientDefinitions.find((definition) => definition.id === 'opencode').label, 'OpenCode');
  assert.equal(sharedCatalog.getProviderTerminalIconAsset('claude'), 'assets/provider-icons/claude.png');
  assert.equal(sharedCatalog.getProviderTerminalBadge('codex'), '◎ GPT');
});
