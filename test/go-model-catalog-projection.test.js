'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../lib/server/v1-router');

function buildList(models) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      owned_by: model.owned_by,
      aih_modalities: model.modalities,
      aih_reasoning_efforts: model.efforts
    }))
  };
}

test('global model catalog projection is deterministic and omits timestamps', () => {
  const projection = __private.buildModelCatalogProjection([
    { id: 'z-model', provider: 'opencode' },
    { id: 'a-model', provider: 'codex' }
  ], () => buildList([
    {
      id: 'z-model', owned_by: 'opencode',
      modalities: { input: ['text'], output: ['text'] }, efforts: ['high']
    },
    {
      id: 'a-model', owned_by: 'openai',
      modalities: { input: ['text', 'image'], output: ['text'] }, efforts: ['low', 'high']
    }
  ]));

  assert.match(projection.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(projection.models, [
    {
      id: 'a-model', owned_by: 'openai',
      input_modalities: ['text', 'image'], output_modalities: ['text'],
      reasoning_efforts: ['low', 'high']
    },
    {
      id: 'z-model', owned_by: 'opencode',
      input_modalities: ['text'], output_modalities: ['text'],
      reasoning_efforts: ['high']
    }
  ]);
  assert.equal(Object.hasOwn(projection.models[0], 'created'), false);
});

test('global model catalog projection revision changes with public capability fields', () => {
  const one = __private.buildModelCatalogProjection([{ id: 'model', provider: 'codex' }], () => buildList([
    { id: 'model', owned_by: 'openai', modalities: { input: ['text'], output: ['text'] }, efforts: [] }
  ]));
  const two = __private.buildModelCatalogProjection([{ id: 'model', provider: 'codex' }], () => buildList([
    { id: 'model', owned_by: 'openai', modalities: { input: ['text', 'image'], output: ['text'] }, efforts: [] }
  ]));
  assert.notEqual(one.revision, two.revision);
});
