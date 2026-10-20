'use strict';

// P5 管理面：价格变化必须经过复核门，approve 后立刻通知宿主重算计价目录。
// 这里不启动插件宿主/网络，只验证路由 → 快照存储 → 回调这条链。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { createPricingCatalogSourceStore } = require('../lib/usage/pricing/catalog-source-store');
const { createPriceQuote } = require('../lib/usage/pricing/price-quote');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');

const MANAGEMENT_KEY = 'test-management-key';

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quote(input, sourceId = 'official:test') {
  return createPriceQuote({
    provider: 'openai',
    model: 'gpt-test',
    input,
    output: input * 2,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite1h: null,
    reasoning: null,
    source: { id: sourceId, kind: 'official', confidence: 0.9 }
  });
}

async function callRoute({ method, pathname, body, state, notifications }) {
  let status = 0;
  let payload = null;
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = { authorization: `Bearer ${MANAGEMENT_KEY}` };
  req.url = pathname;
  const res = {};
  const handled = await handlePluginManagementRequest({
    method,
    pathname,
    req,
    res,
    requiredManagementKey: MANAGEMENT_KEY,
    state,
    deps: {
      aiHomeDir: state.aiHomeDir,
      writeJson: (response, code, value) => {
        assert.equal(response, res);
        status = code;
        payload = value;
      },
      pricingChanged: async () => { notifications.push('pricing'); }
    }
  });
  return { handled, status, payload };
}

test('pricing review queue exposes candidates and applies them only after approval', async (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ fs, aiHomeDir });
  const state = { aiHomeDir };
  const system = getPluginSystem(state, {
    aiHomeDir,
    providerDescriptorSync: false,
    pricingSourceStore: store
  });
  assert.equal(system.pricing.store(), store);

  const first = store.applySnapshot({
    sourceId: 'official:test',
    source: { id: 'official:test', kind: 'official', confidence: 0.9 },
    quotes: [quote(1)],
    requireReview: true
  });
  assert.equal(first.applied, true);
  const changed = store.applySnapshot({
    sourceId: 'official:test',
    source: { id: 'official:test', kind: 'official', confidence: 0.9 },
    quotes: [quote(2)],
    requireReview: true
  });
  assert.equal(changed.applied, false);
  assert.equal(changed.reviewRequired, true);

  const notifications = [];
  const doctor = await callRoute({
    method: 'GET',
    pathname: '/v0/plugins/doctor',
    state,
    notifications
  });
  assert.equal(doctor.status, 200);
  assert.equal(doctor.payload.pricing.pendingReviews, 2);
  assert.equal(doctor.payload.pricing.reviews[0].provider, 'openai');
  // 复核未通过前，生效目录仍是旧价格。
  assert.equal(doctor.payload.pricing.sources[0].quotes, 1);

  const approved = await callRoute({
    method: 'POST',
    pathname: '/v0/plugins/pricing/approve',
    body: { sourceId: 'official:test' },
    state,
    notifications
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(notifications, ['pricing']);
  assert.equal(store.listReviews({ status: 'pending' }).length, 0);
  assert.equal(store.listSources()[0].quotes[0].input, 2);
});

test('rejecting a candidate keeps the old snapshot and does not change prices', async (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ fs, aiHomeDir });
  const state = { aiHomeDir };
  getPluginSystem(state, { aiHomeDir, providerDescriptorSync: false, pricingSourceStore: store });
  store.applySnapshot({
    sourceId: 'official:test',
    source: { id: 'official:test', kind: 'official' },
    quotes: [quote(1)],
    requireReview: true
  });
  store.applySnapshot({
    sourceId: 'official:test',
    source: { id: 'official:test', kind: 'official' },
    quotes: [quote(3)],
    requireReview: true
  });
  const notifications = [];
  const rejected = await callRoute({
    method: 'POST',
    pathname: '/v0/plugins/pricing/reject',
    body: { sourceId: 'official:test' },
    state,
    notifications
  });
  assert.equal(rejected.status, 200);
  assert.deepEqual(notifications, ['pricing']);
  assert.equal(store.listSources()[0].quotes[0].input, 1);
  assert.equal(store.listReviews({ status: 'rejected' }).length, 2);
});
