'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOpenAIModelsList } = require('../lib/server/models');

test('buildOpenAIModelsList infers moonshotai owner for kimi models', () => {
  const { data } = buildOpenAIModelsList([
    { id: 'kimi-for-coding', provider: 'kimi' },
    { id: 'kimi-for-coding-highspeed', provider: 'kimi' },
    { id: 'k3', provider: 'kimi' },
    { id: 'k3-256k', provider: 'kimi' }
  ]);
  const ownerById = new Map(data.map((item) => [item.id, item.owned_by]));
  assert.equal(ownerById.get('kimi-for-coding'), 'moonshotai');
  assert.equal(ownerById.get('kimi-for-coding-highspeed'), 'moonshotai');
  assert.equal(ownerById.get('k3'), 'moonshotai');
  assert.equal(ownerById.get('k3-256k'), 'moonshotai');
});

test('buildOpenAIModelsList still falls back to aih-server for unknown owners', () => {
  const { data } = buildOpenAIModelsList([
    { id: 'some-custom-model', provider: 'kiro' }
  ]);
  assert.equal(data[0].owned_by, 'aih-server');
});
