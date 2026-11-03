'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatRuntimeService } = require('../lib/server/chat-runtime-service');

test('composer catalog reads share an in-flight task and a short cache', async () => {
  let acquisitions = 0;
  let reads = 0;
  const session = { sessionId: 'session-catalog', state: 'idle' };
  const service = Object.create(ChatRuntimeService.prototype);
  service.recovery = { waitForSession: async () => {} };
  service.store = { getSession: () => session };
  service.composerCatalogTasks = new Map();
  service.composerCatalogCache = new Map();
  service.actors = {
    acquire: async () => {
      acquisitions += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { readComposerCatalog: async () => { reads += 1; return { models: [{ id: 'm' }], defaultModel: 'm' }; } };
    }
  };
  const [left, right] = await Promise.all([
    service.readComposerCatalog(session.sessionId),
    service.readComposerCatalog(session.sessionId)
  ]);
  assert.deepEqual(left, right);
  assert.equal(acquisitions, 1);
  assert.equal(reads, 1);
  await service.readComposerCatalog(session.sessionId);
  assert.equal(acquisitions, 1);
  assert.equal(reads, 1);
});

test('recent chat catalog prewarm is bounded and uses the same cache path', async () => {
  const service = Object.create(ChatRuntimeService.prototype);
  const calls = [];
  service.store = { listSessions: ({ limit }) => Array.from({ length: 5 }, (_, index) => ({ sessionId: `s${index}` })).slice(0, limit) };
  service.prewarmComposerCatalog = async (sessionId) => { calls.push(sessionId); };
  await service.prewarmRecentComposerCatalogs(3);
  assert.deepEqual(calls, ['s0', 's1', 's2']);
});
