'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');

const {
  createSessionEventBus,
  normalizeSessionKey
} = require('../lib/server/session-event-bus');

test('normalizeSessionKey creates stable provider session keys', () => {
  assert.equal(
    normalizeSessionKey({
      provider: 'Claude',
      sessionId: 'sess-1',
      projectDirName: 'project-a'
    }),
    JSON.stringify({
      provider: 'claude',
      sessionId: 'sess-1',
      projectDirName: 'project-a',
      projectPath: ''
    })
  );
  assert.equal(normalizeSessionKey({ provider: 'claude' }), '');
});

test('session event bus publishes direct events to matching subscribers', () => {
  const bus = createSessionEventBus({
    fs,
    resolveSessionFilePath() { return ''; }
  });
  const received = [];
  const unsubscribe = bus.subscribe({
    provider: 'gemini',
    sessionId: 'session-1',
    projectDirName: 'project-a'
  }, (event) => {
    received.push(event);
  });

  assert.equal(bus.publish({
    provider: 'gemini',
    sessionId: 'session-1',
    projectDirName: 'project-a'
  }, {
    type: 'session:turn-started',
    source: 'official-hook',
    reason: 'BeforeAgent',
    at: 123
  }), true);

  assert.deepEqual(received, [{
    type: 'session:turn-started',
    provider: 'gemini',
    sessionId: 'session-1',
    projectDirName: 'project-a',
    projectPath: '',
    source: 'official-hook',
    reason: 'BeforeAgent',
    at: 123
  }]);

  unsubscribe();
  assert.deepEqual(bus.getStats(), {
    sessions: 0,
    subscribers: 0,
    watchedFiles: 0
  });
  bus.close();
});

test('session event bus fans out hook events without project hints', () => {
  const bus = createSessionEventBus({
    fs,
    resolveSessionFilePath() { return ''; }
  });
  const received = [];
  bus.subscribe({
    provider: 'claude',
    sessionId: 'session-1',
    projectDirName: 'project-a'
  }, (event) => {
    received.push(event);
  });

  bus.publish({
    provider: 'claude',
    sessionId: 'session-1'
  }, {
    type: 'session:turn-completed',
    source: 'official-hook'
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].projectDirName, 'project-a');
  assert.equal(received[0].source, 'official-hook');
  bus.close();
});

test('session event bus preserves canonical retry status for web watchers', () => {
  const bus = createSessionEventBus({ fs, resolveSessionFilePath() { return ''; } });
  const received = [];
  bus.subscribe({ provider: 'claude', sessionId: 'session-1' }, (event) => received.push(event));

  bus.publish({ provider: 'claude', sessionId: 'session-1' }, {
    type: 'session:retry-status',
    retryStatus: { type: 'retry-status', attempt: 3, maxAttempts: 10 }
  });

  assert.deepEqual(received[0].retryStatus, {
    type: 'retry-status',
    attempt: 3,
    maxAttempts: 10
  });
  bus.close();
});
