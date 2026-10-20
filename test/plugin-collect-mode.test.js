'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODES,
  createCapabilityPipeline
} = require('../lib/plugins/runtime/capability-pipeline');

function buildPipeline(invoke, report = () => {}) {
  const pipeline = createCapabilityPipeline({ invoke, report });
  pipeline.install(7, [
    {
      id: 'source.a',
      instanceId: 'instance.a',
      capability: 'pricing.catalog',
      failurePolicy: 'delegate',
      order: 0
    },
    {
      id: 'source.b',
      instanceId: 'instance.b',
      capability: 'pricing.catalog',
      failurePolicy: 'delegate',
      order: 1
    }
  ]);
  return pipeline;
}

test('collect exposes every contribution result in deterministic order', async () => {
  const pipeline = buildPipeline(async (id) => ({ source: id }));
  const result = await pipeline.collect('pricing.catalog', { now: 1 });

  assert.equal(MODES.collect, 'collect');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.value.source]),
    [['source.a', 'source.a'], ['source.b', 'source.b']]
  );
  assert.deepEqual(result.attempts.map((attempt) => attempt.ok), [true, true]);
});

test('collect skips delegate failures and reports them without dropping healthy sources', async () => {
  const reported = [];
  const pipeline = buildPipeline(async (id) => {
    if (id === 'source.a') throw Object.assign(new Error('catalog unavailable'), { code: 'catalog_unavailable' });
    return { source: id };
  }, (event) => reported.push(event));

  const result = await pipeline.collect('pricing.catalog', {});

  assert.deepEqual(result.items.map((item) => item.id), ['source.b']);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].error, 'catalog_unavailable');
  assert.equal(result.attempts[1].ok, true);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].phase, 'collect');
});

test('collect fails closed for contributions without delegate policy', async () => {
  const pipeline = createCapabilityPipeline({
    invoke: async () => { throw new Error('deny'); },
    report: () => {}
  });
  pipeline.install(1, [{
    id: 'source.deny',
    instanceId: 'instance.deny',
    capability: 'pricing.catalog',
    failurePolicy: 'deny',
    order: 0
  }]);

  await assert.rejects(
    () => pipeline.collect('pricing.catalog', {}),
    /deny/
  );
});
