import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelCapsuleCard, { formatCatalogProvenance } from './ModelCapsuleCard';

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

test('ModelCapsuleCard shows pricing provenance and stale/derived state inline', () => {
  const html = renderToStaticMarkup(
    <ModelCapsuleCard
      {...baseProps}
      pricing={{ input: 2, output: 10 }}
      pricingMeta={{
        status: 'priced',
        stale: true,
        derived: true,
        derivedFrom: 'demo/base-model',
        source: {
          id: 'models.dev',
          kind: 'aggregator',
          authority: 40,
          fetchedAt: '2026-09-01T00:00:00.000Z'
        }
      }}
      onEditPricing={() => {}}
    />
  );
  assert.match(html, /models\.dev/);
  assert.match(html, /过期/);
  assert.match(html, /派生/);
});

test('catalog provenance names the source, snapshot date and stale state', () => {
  const text = formatCatalogProvenance({
    status: 'resolved',
    source: 'models.dev',
    authority: 40,
    fetchedAt: '2026-09-01T00:00:00.000Z',
    stale: true
  });
  assert.match(text, /models\.dev/);
  assert.match(text, /2026-09-01/);
  assert.match(text, /过期/);
});

test('ModelCapsuleCard shows catalog unknown/stale as compact inline state', () => {
  const unknown = renderToStaticMarkup(
    <ModelCapsuleCard
      {...baseProps}
      catalogMeta={{ status: 'unknown', source: 'models.dev' }}
      onEditPricing={() => {}}
    />
  );
  assert.match(unknown, /元数据未知/);

  const stale = renderToStaticMarkup(
    <ModelCapsuleCard
      {...baseProps}
      contextWindow={400000}
      catalogMeta={{ status: 'resolved', source: 'models.dev', stale: true }}
    />
  );
  assert.match(stale, /元数据过期/);
});

test('ModelCapsuleCard marks account custom pricing as the visible source', () => {
  const html = renderToStaticMarkup(
    <ModelCapsuleCard
      {...baseProps}
      pricing={{ input: 2, output: 10 }}
      customPricing={{ input: 1 }}
      onEditPricing={() => {}}
    />
  );
  assert.match(html, /自定义/);
});

// 手动补充的模型必须能删（2026-10-23 用户反馈「手动添加的模型缺少删除」）：
// 后端 POST /v0/webui/openai-models/delete 与 modelsAPI.deleteModel 一直都在，
// 只是卡片从未渲染过删除入口。
test('ModelCapsuleCard renders a delete action only when onDelete is provided', () => {
  const withDelete = renderToStaticMarkup(
    <ModelCapsuleCard {...baseProps} onDelete={() => {}} />
  );
  assert.match(withDelete, /删除模型/);

  // 不传即不渲染：探测来的模型删掉会被下一次探测写回，只该「停用」。
  const withoutDelete = renderToStaticMarkup(<ModelCapsuleCard {...baseProps} />);
  assert.doesNotMatch(withoutDelete, /删除模型/);
});
