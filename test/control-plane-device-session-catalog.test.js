'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachRemoteDevelopmentSession,
  buildRemoteDevelopmentSessionCatalog
} = require('../lib/server/control-plane-device-session-catalog');
const {
  appendNativeChatRunEvent,
  registerNativeChatRun,
  unregisterNativeChatRun
} = require('../lib/server/native-chat-run-store');

test('remote development session catalog combines active runs and snapshot sessions', () => {
  const activeRun = {
    runId: 'run-active-1',
    provider: 'codex',
    accountId: '3',
    projectPath: '/work/ai_home',
    projectDirName: 'work-ai-home',
    eventCursor: 4,
    startedAt: 1000,
    events: [{ cursor: 4, at: 2000, type: 'ready' }]
  };
  const snapshot = {
    projects: [{
      id: 'project-internal',
      name: 'AI Home',
      path: '/work/ai_home',
      sessions: [{
        id: 'raw-session-id',
        provider: 'claude',
        title: 'Planning',
        updatedAt: 1500,
        startedAt: 1200,
        status: 'idle'
      }]
    }]
  };

  const result = buildRemoteDevelopmentSessionCatalog(snapshot, {}, {
    listNativeChatRuns: () => [activeRun]
  });

  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.bySource['active-run'], 1);
  assert.equal(result.summary.bySource['session-snapshot'], 1);
  assert.equal(result.sessions[0].sessionId, 'run-active-1');
  assert.equal(result.sessions[0].status, 'running');
  assert.deepEqual(result.sessions[0].allowedCommands, [
    'attach',
    'detach',
    'message',
    'slash',
    'approval_response',
    'stop'
  ]);
  assert.match(result.sessions[1].sessionId, /^sess_[a-f0-9]{20}$/);
  assert.equal(result.sessions[1].sessionRef, result.sessions[1].sessionId);
  assert.doesNotMatch(JSON.stringify(result), /raw-session-id|project-internal/);
});

test('remote development session attach returns active run cursor and allowed commands', () => {
  const activeRun = {
    runId: 'run-active-attach',
    provider: 'codex',
    eventCursor: 7,
    events: [{ cursor: 7, at: 3000, type: 'assistant_text', text: 'hello' }]
  };

  const result = attachRemoteDevelopmentSession({ projects: [] }, {
    sessionId: 'run-active-attach',
    cursor: 3
  }, {
    getNativeChatRun: (runId) => (runId === activeRun.runId ? activeRun : null),
    readNativeSessionRunEvents: (query) => ({
      runId: query.runId,
      provider: 'codex',
      status: 'running',
      cursor: 7,
      events: [{ cursor: 7, type: 'assistant_text', text: 'hello' }]
    })
  });

  assert.equal(result.sessionId, 'run-active-attach');
  assert.equal(result.cursor, 7);
  assert.equal(result.snapshot.kind, 'run-events');
  assert.equal(result.snapshot.events[0].text, 'hello');
  assert.ok(result.allowedCommands.includes('slash'));
});

test('remote development session attach uses run events reader as active run truth', () => {
  const result = attachRemoteDevelopmentSession({ projects: [] }, {
    sessionId: 'run-reader-only',
    cursor: 3
  }, {
    getNativeChatRun: () => null,
    readNativeSessionRunEvents: (query) => ({
      runId: query.runId,
      provider: 'codex',
      status: 'running',
      cursor: 7,
      events: [{ cursor: 7, type: 'terminal-output', text: 'reader snapshot' }]
    })
  });

  assert.equal(result.sessionId, 'run-reader-only');
  assert.equal(result.cursor, 7);
  assert.equal(result.snapshot.kind, 'run-events');
  assert.equal(result.snapshot.events[0].text, 'reader snapshot');
  assert.ok(result.allowedCommands.includes('message'));
});

test('remote development session attach reads the default native run store', (t) => {
  const runId = 'run-default-store-attach';
  registerNativeChatRun({
    runId,
    provider: 'codex',
    events: [],
    eventCursor: 0,
    completed: false
  });
  t.after(() => unregisterNativeChatRun(runId));
  appendNativeChatRunEvent(runId, {
    type: 'terminal-output',
    text: 'default store snapshot'
  });

  const result = attachRemoteDevelopmentSession({ projects: [] }, {
    sessionId: runId,
    cursor: 0
  });

  assert.equal(result.sessionId, runId);
  assert.equal(result.cursor, 1);
  assert.equal(result.snapshot.kind, 'run-events');
  assert.equal(result.snapshot.events[0].text, 'default store snapshot');
});

test('remote development session attach can target snapshot sessions by stable session ref', () => {
  const snapshot = {
    projects: [{
      name: 'AI Home',
      path: '/work/ai_home',
      sessions: [{
        id: 'snapshot-session',
        provider: 'codex',
        title: 'Snapshot',
        projectDirName: 'work-ai-home',
        updatedAt: 2000
      }]
    }]
  };
  const catalog = buildRemoteDevelopmentSessionCatalog(snapshot, {}, {
    listNativeChatRuns: () => []
  });
  const sessionId = catalog.sessions[0].sessionId;

  const result = attachRemoteDevelopmentSession(snapshot, {
    sessionId,
    cursor: 4
  }, {
    getNativeChatRun: () => null,
    readSessionEvents: (provider, params, options) => ({
      cursor: Number(options.cursor) + 5,
      events: [{ type: 'assistant_text', text: `${provider}:${params.sessionId}` }]
    })
  });

  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sessionRef, sessionId);
  assert.equal(result.snapshot.kind, 'session-events');
  assert.equal(result.cursor, 9);
  assert.equal(result.snapshot.events[0].text, 'codex:snapshot-session');
});
