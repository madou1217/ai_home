'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MODEL_NAMESPACE_HEADER,
  applyModelNamespaceHeader
} = require('../lib/server/model-namespace-header');

test('a declared namespace prefixes a bare model name', () => {
  const out = applyModelNamespaceHeader({ [MODEL_NAMESPACE_HEADER]: 'opencode' }, { model: 'some-free', stream: true });
  assert.deepEqual(out, { model: 'opencode/some-free', stream: true });
});

test('an already namespaced model is left alone', () => {
  assert.equal(applyModelNamespaceHeader({ [MODEL_NAMESPACE_HEADER]: 'opencode' }, { model: 'zen/x' }), null);
});

test('no header or an invalid namespace changes nothing', () => {
  assert.equal(applyModelNamespaceHeader({}, { model: 'x' }), null);
  assert.equal(applyModelNamespaceHeader({ [MODEL_NAMESPACE_HEADER]: '../evil' }, { model: 'x' }), null);
  assert.equal(applyModelNamespaceHeader({ [MODEL_NAMESPACE_HEADER]: 'opencode' }, { model: '' }), null);
  assert.equal(applyModelNamespaceHeader({ [MODEL_NAMESPACE_HEADER]: 'opencode' }, null), null);
});
