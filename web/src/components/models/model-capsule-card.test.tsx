import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelCapsuleCard from './ModelCapsuleCard';

const baseProps = {
  modelId: 'demo-model',
  provider: 'demo',
  accountRef: 'acct_demo'
};

test('ModelCapsuleCard keeps the pricing editor reachable when the catalog has no price', () => {
  const html = renderToStaticMarkup(
    <ModelCapsuleCard {...baseProps} onEditPricing={() => {}} />
  );
  assert.match(html, /价格未知/);
});

test('ModelCapsuleCard omits the unknown-price placeholder when no editor is available', () => {
  const html = renderToStaticMarkup(<ModelCapsuleCard {...baseProps} />);
  assert.doesNotMatch(html, /价格未知/);
});

test('ModelCapsuleCard renders catalog prices instead of the unknown placeholder', () => {
  const html = renderToStaticMarkup(
    <ModelCapsuleCard {...baseProps} pricing={{ input: 1.5, output: 3 }} onEditPricing={() => {}} />
  );
  assert.doesNotMatch(html, /价格未知/);
  assert.match(html, /\$1\.50/);
  assert.match(html, /\$3\.0/);
});
