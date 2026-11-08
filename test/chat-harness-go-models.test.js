'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatHarnessModelReader } = require('../lib/server/chat-runtime/chat-harness-model-reader');
const {
  ACCOUNT_MODELS_PATH,
  createChatHarnessGoModelSource
} = require('../lib/server/chat-runtime/chat-harness-go-models');

const NODE_REF = 'acct_0123456789abcdef0123';
const GO_REF = 'acct_ffffffffffffffffffff';
const ORPHAN_GO_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';

function gatewayState(byAccount = {}) {
  return {
    accounts: {
      zcode: [{ accountRef: NODE_REF, provider: 'zcode', authMode: 'oauth' }]
    },
    modelCatalogSettings: {},
    webUiModelsCache: {
      updatedAt: Date.now(),
      signature: 'test-signature',
      byAccount,
      accountUpdatedAt: {}
    }
  };
}

function goAccountModelsResponse(accounts, meta = {}) {
  return {
    ok: true,
    status: 200,
    data: accounts,
    body: { data: accounts, ...meta }
  };
}

function isStampPath(path) {
  return String(path).includes('meta_only=1');
}

function goStampResponse(generation, updatedAtMs = 0) {
  return {
    ok: true,
    status: 200,
    data: [],
    body: { data: [], generation, updated_at_ms: updatedAtMs }
  };
}

function pendingProbe() {
  return new Promise(() => {});
}

test('Go 优先：gateway catalog comes from Go effective rows with Go→Node ref translation', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let requestedPath = '';
  let probes = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    nodeAccountRefFor: (ref) => (ref === GO_REF ? NODE_REF : ref),
    readGoAccountModels: async (path) => {
      if (isStampPath(path)) return goStampResponse(1, 1);
      requestedPath = path;
      return goAccountModelsResponse([
        {
          account_ref: GO_REF,
          provider_id: 'zcode',
          models: [
            { model_id: 'glm-5.3', effective: true },
            { model_id: 'glm-5.3-disabled', effective: false }
          ]
        },
        {
          account_ref: ORPHAN_GO_REF,
          provider_id: 'zcode',
          models: [{ model_id: 'orphan-model', effective: true }]
        }
      ], { generation: 1, updated_at_ms: 1 });
    },
    fetchModelsForAccount: () => { probes += 1; return []; }
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['glm-5.3']);
  assert.equal(requestedPath, ACCOUNT_MODELS_PATH);
  assert.equal(probes, 0);
});

test('Go 优先：Go 503 falls back to the local snapshot', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  state.webUiModelsCache.updatedAt = 1;
  state.webUiModelsCache.signature = 'stale';
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    nodeAccountRefFor: (ref) => ref,
    readGoAccountModels: async () => {
      goReads += 1;
      return { ok: false, status: 503, data: null, body: null, errorCode: 'http_503' };
    },
    fetchModelsForAccount: pendingProbe
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['snapshot-model']);
  assert.equal(goReads, 1);
});

test('Go 优先：Go with no effective rows falls back to the local snapshot', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    nodeAccountRefFor: (ref) => ref,
    readGoAccountModels: async (path) => {
      goReads += 1;
      if (isStampPath(path)) return goStampResponse(2, 2);
      return goAccountModelsResponse([
        {
          account_ref: GO_REF,
          provider_id: 'zcode',
          models: [{ model_id: 'disabled-model', effective: false }]
        }
      ], { generation: 2, updated_at_ms: 2 });
    },
    fetchModelsForAccount: pendingProbe
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['snapshot-model']);
  // 冷启动只有一次整份拉取；没有 effective 行时回落快照。
  assert.equal(goReads, 1);
});

test('Go model source times out to null instead of blocking the harness', async () => {
  const source = createChatHarnessGoModelSource({
    readAccountModels: pendingProbe,
    timeoutMs: 5
  });

  assert.equal(await source(), null);
});

function generationSource({ initialGeneration = 7, refreshTtlMs, now } = {}) {
  let generation = initialGeneration;
  let failStamp = false;
  let fullReads = 0;
  let stampReads = 0;
  const source = createChatHarnessGoModelSource({
    readAccountModels: async (path) => {
      if (isStampPath(path)) {
        stampReads += 1;
        if (failStamp) return { ok: false, status: 503, data: null, body: null };
        return goStampResponse(generation, 100);
      }
      fullReads += 1;
      return goAccountModelsResponse([
        {
          account_ref: 'acct_a',
          provider_id: 'zcode',
          models: [{ model_id: 'glm-5.3', effective: true }]
        }
      ], { generation, updated_at_ms: 100 });
    },
    refreshTtlMs,
    now
  });
  return {
    source,
    setGeneration: (value) => { generation = value; },
    setFailStamp: (value) => { failStamp = value; },
    counts: () => ({ fullReads, stampReads })
  };
}

test('generation 相同：复用上次目录，不再整份拉取', async () => {
  const helper = generationSource({ now: () => 1000 });

  const first = await helper.source();
  const second = await helper.source();

  assert.deepEqual(first.byAccount, { acct_a: ['glm-5.3'] });
  assert.deepEqual(second.byAccount, first.byAccount);
  assert.equal(second.generation, 7);
  assert.equal(first.updatedAtMs, 100);
  // 冷启动整份拉取一次；第二次只做轻量指纹探测后复用缓存。
  assert.deepEqual(helper.counts(), { fullReads: 1, stampReads: 1 });
});

test('generation 变化：重新整份拉取', async () => {
  const helper = generationSource({ now: () => 1000 });

  await helper.source();
  helper.setGeneration(8);
  const second = await helper.source();

  assert.equal(second.generation, 8);
  assert.deepEqual(helper.counts(), { fullReads: 2, stampReads: 1 });
});

test('generation 回退：仍按变化处理并重新整份拉取', async () => {
  const helper = generationSource({ initialGeneration: 9, now: () => 1000 });

  await helper.source();
  helper.setGeneration(3);
  const second = await helper.source();

  assert.equal(second.generation, 3);
  assert.deepEqual(helper.counts(), { fullReads: 2, stampReads: 1 });
});

test('generation 相同但 TTL 到期：强制整份刷新', async () => {
  let clock = 1000;
  const helper = generationSource({ refreshTtlMs: 100, now: () => clock });

  await helper.source();
  clock += 99;
  await helper.source();
  assert.equal(helper.counts().fullReads, 1);
  clock += 1;
  await helper.source();
  assert.equal(helper.counts().fullReads, 2);
});

test('Go 失败：返回 null 让调用方回落快照', async () => {
  const helper = generationSource({ now: () => 1000 });

  assert.notEqual(await helper.source(), null);
  helper.setFailStamp(true);
  assert.equal(await helper.source(), null);
});


test('命中 generation 缓存时仍按当前 Node↔Go 映射翻译', async () => {
  let mapping = { acct_go_1: 'node_1' };
  const source = createChatHarnessGoModelSource({
    readAccountModels: async (path) => {
      if (isStampPath(path)) return goStampResponse(5, 100);
      return goAccountModelsResponse([
        {
          account_ref: 'acct_go_1',
          provider_id: 'zcode',
          models: [{ model_id: 'glm-5.3', effective: true }]
        }
      ], { generation: 5, updated_at_ms: 100 });
    },
    nodeAccountRefFor: (ref) => mapping[ref] || ref,
    now: () => 1000
  });

  const first = await source();
  mapping = { acct_go_1: 'node_2' };
  const second = await source();

  assert.deepEqual(first.byAccount, { node_1: ['glm-5.3'] });
  assert.deepEqual(second.byAccount, { node_2: ['glm-5.3'] });
});
test('响应缺 generation：不能按相同处理，继续整份拉取', async () => {
  let fullReads = 0;
  let stampReads = 0;
  const source = createChatHarnessGoModelSource({
    readAccountModels: async (path) => {
      if (isStampPath(path)) {
        stampReads += 1;
        return { ok: true, status: 200, data: [], body: { data: [] } };
      }
      fullReads += 1;
      return goAccountModelsResponse([
        {
          account_ref: 'acct_a',
          provider_id: 'zcode',
          models: [{ model_id: 'glm-5.3', effective: true }]
        }
      ]);
    }
  });

  await source();
  await source();

  assert.equal(fullReads, 2);
  assert.equal(stampReads, 1);
});
