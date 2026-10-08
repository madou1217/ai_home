'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isCodexAppServerIdle } = require('../lib/server/codex-app-server-idle-state');

test('runtime policy upgrade checks every page and preserves an active native writer', async () => {
  const calls = [];
  let destroyed = false;
  const idle = await isCodexAppServerIdle(12345, { clientFactory: () => ({
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return params.cursor
        ? { data: ['busy'], nextCursor: null } : { data: ['idle'], nextCursor: 'page-2' };
      return { thread: { status: { type: params.threadId === 'busy' ? 'active' : 'idle' } } };
    },
    destroy() { destroyed = true; }
  }) });
  assert.equal(idle, false);
  assert.equal(destroyed, true);
  assert.deepEqual(calls.filter((call) => call.method === 'thread/read').map((call) => call.params), [
    { threadId: 'idle', includeTurns: false }, { threadId: 'busy', includeTurns: false }
  ]);
});

test('only empty or explicitly idle native threads permit an upgrade', async () => {
  for (const type of ['idle', 'notLoaded', 'active', 'systemError', undefined]) {
    const idle = await isCodexAppServerIdle(12345, { clientFactory: () => ({
      async request(method) {
        return method === 'thread/loaded/list' ? { data: ['t'], nextCursor: null } : { thread: { status: { type } } };
      },
      destroy() {}
    }) });
    assert.equal(idle, ['idle', 'notLoaded'].includes(type));
  }
});

test('an unavailable native probe times out and preserves the existing runtime', async () => {
  let destroyed = false;
  assert.equal(await isCodexAppServerIdle(12345, { timeoutMs: 5, clientFactory: () => ({
    request: () => new Promise(() => {}), destroy() { destroyed = true; }
  }) }), false);
  assert.equal(destroyed, true);
});

test('malformed or looping native pagination cannot authorize an upgrade', async () => {
  for (const page of [{}, { data: [], nextCursor: 'same-page' }]) {
    assert.equal(await isCodexAppServerIdle(12345, { clientFactory: () => ({
      request: async () => page, destroy() {}
    }) }), false);
  }
});
