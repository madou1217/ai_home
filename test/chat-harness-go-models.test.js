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

function pendingProbe() {
  return new Promise(() => {});
}

test('switch on: gateway catalog comes from Go effective rows with Go→Node ref translation', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let requestedPath = '';
  let probes = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    readServerConfig: () => ({ harnessModelsViaGo: true }),
    nodeAccountRefFor: (ref) => (ref === GO_REF ? NODE_REF : ref),
    readGoAccountModels: async (path) => {
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
      ]);
    },
    fetchModelsForAccount: () => { probes += 1; return []; }
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['glm-5.3']);
  assert.equal(requestedPath, ACCOUNT_MODELS_PATH);
  assert.equal(probes, 0);
});

test('switch on: Go 503 falls back to the local snapshot', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  state.webUiModelsCache.updatedAt = 1;
  state.webUiModelsCache.signature = 'stale';
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    readServerConfig: () => ({ harnessModelsViaGo: true }),
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

test('switch off: golden response is unchanged and Go is never read', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    readServerConfig: () => ({ harnessModelsViaGo: false }),
    nodeAccountRefFor: (ref) => ref,
    readGoAccountModels: async () => {
      goReads += 1;
      return goAccountModelsResponse([]);
    },
    fetchModelsForAccount: pendingProbe
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['snapshot-model']);
  assert.equal(goReads, 0);
});

test('switch defaults off when no config reader is wired', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    readGoAccountModels: async () => {
      goReads += 1;
      return goAccountModelsResponse([]);
    },
    fetchModelsForAccount: pendingProbe
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['snapshot-model']);
  assert.equal(goReads, 0);
});

test('switch on: Go with no effective rows falls back to the local snapshot', async () => {
  const state = gatewayState({ [NODE_REF]: ['snapshot-model'] });
  let goReads = 0;
  const readModels = createChatHarnessModelReader({
    getState: () => state,
    readServerConfig: () => ({ harnessModelsViaGo: true }),
    nodeAccountRefFor: (ref) => ref,
    readGoAccountModels: async () => {
      goReads += 1;
      return goAccountModelsResponse([
        {
          account_ref: GO_REF,
          provider_id: 'zcode',
          models: [{ model_id: 'disabled-model', effective: false }]
        }
      ]);
    },
    fetchModelsForAccount: pendingProbe
  });

  const models = await readModels('zcode', 'gateway');

  assert.deepEqual(models, ['snapshot-model']);
  assert.equal(goReads, 1);
});

test('Go model source times out to null instead of blocking the harness', async () => {
  const source = createChatHarnessGoModelSource({
    readAccountModels: pendingProbe,
    timeoutMs: 5
  });

  assert.equal(await source(), null);
});
