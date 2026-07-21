'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CodexNativeModelCatalog
} = require('../lib/server/chat-runtime/codex-native-model-catalog');

test('Codex native catalog resolves requested/default models with native effort defaults', async () => {
  const fixture = createFixture();
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  assert.deepEqual(await catalog.resolveTurnSettings({ model: 'gpt-first' }), {
    model: 'gpt-first',
    reasoningEffort: 'low'
  });
  assert.deepEqual(await catalog.resolveTurnSettings(), {
    model: 'gpt-account-default',
    reasoningEffort: 'medium'
  });
  assert.deepEqual(fixture.requests, [
    { method: 'model/list', params: { includeHidden: false } }
  ]);
});

test('Codex native catalog rejects an explicit model absent from the account catalog', async () => {
  const fixture = createFixture();
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  await assert.rejects(
    catalog.resolveTurnSettings({ model: 'missing-model' }),
    (error) => (
      error.code === 'codex_native_model_unavailable'
      && error.statusCode === 422
      && error.details.model === 'missing-model'
      && error.details.availableModels.join(',') === 'gpt-first,gpt-account-default'
    )
  );
});

test('Codex native catalog rejects a native default effort outside its supported list', async () => {
  const fixture = createFixture({
    modelResponse: {
      data: [model('gpt-invalid-default', true, ['low', 'medium'], 'high')]
    }
  });
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  await assert.rejects(
    catalog.resolveTurnSettings(),
    (error) => (
      error.code === 'codex_native_model_catalog_invalid'
      && error.statusCode === 502
      && error.details.model === 'gpt-invalid-default'
    )
  );
});

test('Codex native catalog accepts supported explicit effort and rejects unsupported effort', async () => {
  const fixture = createFixture();
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  assert.deepEqual(await catalog.resolveTurnSettings({ reasoningEffort: 'high' }), {
    model: 'gpt-account-default',
    reasoningEffort: 'high'
  });
  await assert.rejects(
    catalog.resolveTurnSettings({ reasoningEffort: 'max' }),
    (error) => (
      error.code === 'codex_native_reasoning_effort_unsupported'
      && error.statusCode === 422
      && error.details.model === 'gpt-account-default'
      && error.details.reasoningEffort === 'max'
      && error.details.supportedReasoningEfforts.join(',') === 'medium,high'
    )
  );
});

test('Codex native catalog exposes the verified provider catalog for composer rendering', async () => {
  const fixture = createFixture();
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  assert.deepEqual(await catalog.list(), [
    {
      model: 'gpt-first',
      displayName: 'GPT First',
      isDefault: false,
      supportedReasoningEfforts: ['low'],
      defaultReasoningEffort: 'low'
    },
    {
      model: 'gpt-account-default',
      displayName: 'GPT Account Default',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium'
    }
  ]);
});

test('Codex native catalog accepts a verified API-key execution credential', async () => {
  const fixture = createFixture({
    identity: {
      verified: true,
      kind: 'api-key',
      assurance: 'execution-credential'
    }
  });
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  assert.deepEqual(await catalog.resolveTurnSettings(), {
    model: 'gpt-account-default',
    reasoningEffort: 'medium'
  });
});

test('Codex native catalog gates model/list behind connection and verified OAuth identity', async () => {
  const fixture = createFixture();
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  await catalog.resolveTurnSettings();

  assert.deepEqual(fixture.sequence.slice(0, 3), [
    'ensureConnected',
    'getVerifiedAccountIdentity',
    'model/list'
  ]);
});

test('Codex native catalog single-flights prewarm and turn resolution for one driver', async () => {
  const gate = deferred();
  const fixture = createFixture({ modelResponse: gate.promise });
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  const prewarm = catalog.prewarm();
  const second = catalog.resolveTurnSettings({ model: 'gpt-first' });
  await nextTask();
  assert.equal(fixture.requests.length, 1);

  gate.resolve(defaultModelResponse());
  await prewarm;
  assert.deepEqual(await second, {
    model: 'gpt-first', reasoningEffort: 'low'
  });
});

test('Codex native catalog shares one verified model list across session drivers on a resident client', async () => {
  const gate = deferred();
  const fixture = createFixture({ modelResponse: gate.promise });
  const firstSession = new CodexNativeModelCatalog({ client: fixture.client });
  const secondSession = new CodexNativeModelCatalog({ client: fixture.client });

  const first = firstSession.resolveTurnSettings({ model: 'gpt-first' });
  const second = secondSession.resolveTurnSettings();
  await nextTask();

  assert.equal(fixture.requests.length, 1);
  gate.resolve(defaultModelResponse());
  assert.deepEqual(await first, { model: 'gpt-first', reasoningEffort: 'low' });
  assert.deepEqual(await second, {
    model: 'gpt-account-default', reasoningEffort: 'medium'
  });
});

test('Codex native catalog fails closed before model/list without verified identity', async () => {
  const fixture = createFixture({ identity: null });
  const catalog = new CodexNativeModelCatalog({ client: fixture.client });

  await assert.rejects(
    catalog.resolveTurnSettings(),
    (error) => error.code === 'codex_native_model_identity_not_verified'
  );
  assert.deepEqual(fixture.requests, []);
});

function createFixture(overrides = {}) {
  const requests = [];
  const sequence = [];
  const identity = Object.prototype.hasOwnProperty.call(overrides, 'identity')
    ? overrides.identity
    : { verified: true, kind: 'oauth', assurance: 'identity' };
  return {
    requests,
    sequence,
    client: {
      async ensureConnected() {
        sequence.push('ensureConnected');
      },
      getVerifiedAccountIdentity() {
        sequence.push('getVerifiedAccountIdentity');
        return identity;
      },
      async request(method, params) {
        sequence.push(method);
        requests.push({ method, params });
        return Object.prototype.hasOwnProperty.call(overrides, 'modelResponse')
          ? overrides.modelResponse
          : defaultModelResponse();
      }
    }
  };
}

function defaultModelResponse() {
  return {
    data: [
      model('gpt-first', false, ['low'], 'low'),
      model('gpt-account-default', true, ['medium', 'high'], 'medium')
    ]
  };
}

function model(name, isDefault, efforts, defaultEffort) {
  return {
    model: name,
    displayName: name === 'gpt-first' ? 'GPT First' : 'GPT Account Default',
    isDefault,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: defaultEffort
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}
