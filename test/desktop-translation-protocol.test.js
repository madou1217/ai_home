'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../lib/desktop/translation/protocol');

test('settings messages are versioned and right click never becomes a translation command', () => {
  assert.deepEqual(protocol.normalizeHelperEvent({ type: 'settings', action: 'save', patch: { target: 'zh-Hans' } }), {
    version: 1, type: 'settings', action: 'save', patch: { target: 'zh-Hans' }
  });
  assert.equal(protocol.normalizeHelperEvent({ type: 'right-click', text: 'secret' }), null);
});

test('normalizes supported helper events and drops oversized or unknown payloads', () => {
  assert.deepEqual(protocol.normalizeHelperEvent({ type: 'cancel', id: 'req-1' }), {
    version: 1, type: 'cancel', id: 'req-1'
  });
  assert.deepEqual(protocol.normalizeHelperEvent({
    version: 1,
    type: 'translate',
    id: 'req-2',
    text: 'hello',
    target: 'zh-Hans',
    targetPolicy: 'explicit'
  }), {
    version: 1,
    type: 'translate',
    id: 'req-2',
    text: 'hello',
    target: 'zh-Hans',
    targetPolicy: 'explicit'
  });
  assert.equal(protocol.normalizeHelperEvent({ type: 'unknown', text: 'secret' }), null);
  assert.equal(protocol.normalizeHelperEvent({ type: 'translate', text: 'x'.repeat(8001) }), null);
});

test('caps settings patch fields and removes text from settings events', () => {
  const normalized = protocol.normalizeHelperEvent({
    type: 'settings',
    action: 'save',
    patch: {
      target: 'zh-Hans',
      autoCopy: true,
      copyScope: 'selection',
      executionTarget: 'direct-provider',
      text: 'secret',
      oversized: 'x'.repeat(10000)
    }
  });
  assert.deepEqual(normalized, {
    version: 1,
    type: 'settings',
    action: 'save',
    patch: {
      target: 'zh-Hans',
      autoCopy: true,
      copyScope: 'selection',
      executionTarget: 'direct-provider'
    }
  });
  assert.deepEqual(protocol.normalizeHelperEvent({ type: 'settings', action: 'close' }), {
    version: 1, type: 'settings', action: 'close'
  });
});
