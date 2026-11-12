'use strict';

// server 配置的跨语言对拍：Node sanitizeServerConfig 与 Go webuiserverconfigapi
// 读同一份夹具（test/fixtures/server-config-sanitize-cases.json）。
// 任何一侧改规则而另一侧没跟上，都会在这条用例或 Go 的同名测试里变红。

const test = require('node:test');
const assert = require('node:assert/strict');

const cases = require('./fixtures/server-config-sanitize-cases.json');
const { sanitizeServerConfig } = require('../lib/server/server-config-store');

function toPublic(config) {
  return {
    ...config,
    apiKey: '',
    managementKey: '',
    apiKeyConfigured: Boolean(String(config.apiKey || '').trim()),
    managementKeyConfigured: Boolean(String(config.managementKey || '').trim())
  };
}

for (const testCase of cases) {
  test('server config parity: ' + testCase.name, () => {
    assert.deepEqual(toPublic(sanitizeServerConfig(testCase.input)), testCase.public);
  });
}
