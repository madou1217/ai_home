'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getProviderAuthOptions,
  listProviderDefinitions,
  listProviderIds
} = require('../lib/provider-catalog');

// resolveProviderAuthOptions 模拟 Accounts 页面面对未知 Provider 时的安全读取方式。
function resolveProviderAuthOptions(provider) {
  return getProviderAuthOptions(provider);
}

test('每个 Provider 都由生成合同提供非空认证选项', () => {
  const definitions = listProviderDefinitions();
  const catalogIds = listProviderIds();

  assert.deepEqual(definitions.map((definition) => definition.id), catalogIds);
  for (const definition of definitions) {
    const options = resolveProviderAuthOptions(definition.id);
    assert.ok(options.length > 0, `${definition.id} 缺少认证选项`);
    assert.deepEqual(options, definition.authOptions);
  }
});

test('Qoder 两个区域的认证选项可安全遍历', () => {
  for (const provider of ['qoder', 'qodercn']) {
    const options = resolveProviderAuthOptions(provider);
    assert.doesNotThrow(() => options.map((option) => option.value));
    assert.ok(options.some((option) => option.value === 'oauth-browser'));
  }
});

test('未知 Provider 返回空认证选项而不是 undefined', () => {
  const options = resolveProviderAuthOptions('missing-provider');

  assert.deepEqual(options, []);
  assert.doesNotThrow(() => options.map((option) => option.value));
});
