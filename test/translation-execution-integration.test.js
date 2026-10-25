'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranslationExecutionPort } = require('../lib/translation/execution-port');
const { createSystemTranslationService } = require('../lib/desktop/translation/service');

function request(overrides = {}) {
  return {
    id: 'request-1',
    target: 'direct-provider',
    operation: 'selection',
    text: 'hello',
    source: 'en',
    targetLanguage: 'zh-Hans',
    routes: [{ id: 'microsoft-route', provider: 'microsoft', model: 'default', enabled: true, priority: 0, operations: ['selection'] }],
    ...overrides
  };
}

test('retryable direct-provider failure falls back to AIH Server and combines attempts', async () => {
  const calls = [];
  const direct = async () => {
    calls.push('direct-provider');
    return {
      ok: false,
      text: '',
      attempts: [{ attempt: 1, ok: false }],
      error: { code: 'translation_network_error', message: '直连不可用', retryable: true }
    };
  };
  const server = async (input) => {
    calls.push(input.target);
    return { ok: true, text: '服务端译文', attempts: [{ attempt: 1, ok: true }] };
  };
  const result = await createTranslationExecutionPort({ direct, server }).translate(request({ fallbackTarget: 'aih-server' }));
  assert.equal(result.ok, true);
  assert.equal(result.text, '服务端译文');
  assert.deepEqual(calls, ['direct-provider', 'aih-server']);
  assert.equal(result.attempts.length, 2);
});

test('desktop service routes translation through the injected execution port', async () => {
  const calls = [];
  const executionPort = {
    translate: async (input, options) => {
      calls.push({ input, options });
      options.emit({ type: 'delta', content: '直连结果' });
      return { ok: true, text: '直连结果', usage: null, attempts: [] };
    }
  };
  const service = createSystemTranslationService({
    fs: {},
    aiHomeDir: '',
    platform: 'linux',
    executionPort
  });
  const result = await service.translate({ id: 'request-1', text: 'hello', target: 'zh-Hans' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.target, 'aih-server');
  assert.equal(calls[0].input.origin, '');
  assert.equal(typeof calls[0].options.isCurrent, 'function');
  service.stop();
});

test('full-app status does not claim an AIH Server is configured without a port', () => {
  const service = createSystemTranslationService({ fs: {}, aiHomeDir: '', platform: 'linux', mode: 'full-app' });
  const status = service.getStatus();
  const serverTarget = status.executionTargets.find((item) => item.id === 'aih-server');
  const directTarget = status.executionTargets.find((item) => item.id === 'direct-provider');
  assert.equal(status.executionTarget, 'direct-provider');
  assert.equal(status.serverTarget.origin, '');
  assert.equal(serverTarget.configured, false);
  assert.equal(directTarget.available, true);
  assert.equal(directTarget.capabilities.operations.includes('selection'), true);
  assert.equal(Array.isArray(directTarget.providers), true);
  service.stop();
});
