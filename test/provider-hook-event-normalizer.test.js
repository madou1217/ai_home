'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProviderHookEvent,
  resolveEventType
} = require('../lib/server/provider-hook-event-normalizer');

test('normalizes Codex hook payload into session bus event', () => {
  const normalized = normalizeProviderHookEvent('codex', {
    session_id: 'codex-session-1',
    transcript_path: '/tmp/codex-session.jsonl',
    cwd: '/repo',
    hook_event_name: 'Stop',
    turn_id: 'turn-1',
    timestamp: '2026-06-08T12:00:00.000Z'
  });

  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.session, {
    provider: 'codex',
    sessionId: 'codex-session-1',
    projectDirName: '',
    projectPath: '/repo'
  });
  assert.equal(normalized.event.type, 'session:turn-completed');
  assert.equal(normalized.event.source, 'official-hook');
  assert.equal(normalized.event.eventName, 'Stop');
  assert.equal(normalized.event.phase, 'turn-completed');
  assert.equal(normalized.event.transcriptPath, '/tmp/codex-session.jsonl');
  assert.equal(normalized.event.turnId, 'turn-1');
});

test('normalizes Codex app-server proxy events with explicit source', () => {
  const normalized = normalizeProviderHookEvent('codex', {
    session_id: 'codex-thread-1',
    eventName: 'AppServerTurnStarted',
    source: 'codex-app-server-proxy',
    turn_id: 'turn-1'
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.type, 'session:turn-started');
  assert.equal(normalized.event.source, 'codex-app-server-proxy');
  assert.equal(normalized.event.eventName, 'AppServerTurnStarted');
  assert.equal(normalized.event.turnId, 'turn-1');
});

test('normalizes Claude hook payload without prompt or tool body fields', () => {
  const normalized = normalizeProviderHookEvent('claude', {
    session_id: 'claude-session-1',
    transcript_path: '/tmp/claude-session.jsonl',
    cwd: '/repo',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'sensitive prompt text'
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.type, 'session:turn-started');
  assert.equal(normalized.event.eventName, 'UserPromptSubmit');
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.event, 'prompt'), false);
});

test('normalizes Gemini lifecycle and agent hooks', () => {
  const start = normalizeProviderHookEvent('gemini', {
    session_id: 'gemini-session-1',
    transcript_path: '/tmp/gemini-session.json',
    cwd: '/repo',
    hook_event_name: 'BeforeAgent',
    prompt: 'hello'
  });
  const done = normalizeProviderHookEvent('gemini', {
    session_id: 'gemini-session-1',
    transcript_path: '/tmp/gemini-session.json',
    cwd: '/repo',
    hook_event_name: 'AfterAgent',
    prompt_response: 'hi'
  });

  assert.equal(start.ok, true);
  assert.equal(start.event.type, 'session:turn-started');
  assert.equal(done.ok, true);
  assert.equal(done.event.type, 'session:turn-completed');
  assert.equal(Object.prototype.hasOwnProperty.call(done.event, 'prompt_response'), false);
});

test('normalizes Agy camelCase hook payload using conversationId', () => {
  const normalized = normalizeProviderHookEvent('agy', {
    conversationId: 'agy-conversation-1',
    workspacePaths: ['/repo'],
    transcriptPath: '/repo/.gemini/antigravity/transcript.jsonl',
    artifactDirectoryPath: '/repo/.gemini/antigravity/artifacts',
    executionNum: 1,
    terminationReason: 'model_stop',
    error: '',
    fullyIdle: true
  });

  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.session, {
    provider: 'agy',
    sessionId: 'agy-conversation-1',
    projectDirName: '',
    projectPath: '/repo'
  });
  assert.equal(normalized.event.type, 'session:turn-completed');
  assert.equal(normalized.event.eventName, 'Stop');
  assert.equal(normalized.event.transcriptPath, '/repo/.gemini/antigravity/transcript.jsonl');
});

test('maps Agy non-idle Stop to update instead of completed', () => {
  const normalized = normalizeProviderHookEvent('agy', {
    conversationId: 'agy-conversation-1',
    workspacePaths: ['/repo'],
    transcriptPath: '/repo/.gemini/antigravity/transcript.jsonl',
    executionNum: 1,
    terminationReason: 'model_stop',
    fullyIdle: false
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.type, 'session:turn-updated');
});

test('normalizes Agy invocation hooks when event name is supplied by wrapper', () => {
  const normalized = normalizeProviderHookEvent('agy', {
    conversationId: 'agy-conversation-2',
    workspacePaths: ['/repo'],
    transcriptPath: '/repo/.gemini/antigravity/transcript.jsonl',
    invocationNum: 3,
    initialNumSteps: 10
  }, {
    eventName: 'PreInvocation'
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.event.eventName, 'PreInvocation');
  assert.equal(normalized.event.type, 'session:turn-updated');
  assert.equal(normalized.event.turnId, '3');
});

test('rejects unsupported provider or missing session id', () => {
  assert.deepEqual(normalizeProviderHookEvent('unknown', { session_id: 's1' }), {
    ok: false,
    error: 'unsupported_provider'
  });
  assert.deepEqual(normalizeProviderHookEvent('codex', { hook_event_name: 'Stop' }), {
    ok: false,
    error: 'missing_session_id'
  });
});

test('resolveEventType keeps unknown events as session update', () => {
  assert.equal(resolveEventType('FutureEvent', 'codex', {}), 'session:updated');
});
