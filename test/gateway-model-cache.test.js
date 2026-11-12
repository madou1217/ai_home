'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeGatewayModelCache,
  readPersistedGatewayModelCache,
  writePersistedGatewayModelCache
} = require('../lib/server/gateway-model-cache');

function createMemoryCache() {
  let value = null;
  return {
    readCacheJson: () => value,
    writeCacheJson: (_deps, _file, next) => { value = next; }
  };
}

test('gateway model cache rejects malformed or oversized bodies', () => {
  assert.equal(normalizeGatewayModelCache({ body: '{"data":[]}' }).body, '{"data":[]}');
  assert.equal(normalizeGatewayModelCache({ body: '{"models":[]}' }).body, '');
  assert.equal(normalizeGatewayModelCache({ body: 'x'.repeat(4 * 1024 * 1024 + 1) }).body, '');
});

test('gateway model cache round trips the public snapshot', () => {
  const memory = createMemoryCache();
  const input = {
    updatedAt: 123,
    pluginGeneration: 2,
    signature: 'accounts',
    body: JSON.stringify({ object: 'list', data: [{ id: 'gpt-6.1-sol' }] }),
    projection: { revision: 'r1', models: [{ id: 'gpt-6.1-sol' }] }
  };
  writePersistedGatewayModelCache({ cacheWriteJson: memory.writeCacheJson }, input);
  // 归一化后固定形状：模型→账号/provider 绑定缺席时显式为 null（消费方据此判定「无归属证据」）。
  assert.deepEqual(readPersistedGatewayModelCache({ cacheReadJson: memory.readCacheJson }), {
    ...input,
    modelAccounts: null,
    modelProviders: null
  });
});
