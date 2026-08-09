'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCodexResumeThreadId,
  resolveCodexPersistentThreadId,
  selectPreferredCodexPersistentOwner
} = require('../lib/runtime/codex-persistent-thread');

const THREAD_ID = '019f97d8-2007-7f90-8f8b-d627bd6b0327';

test('extractCodexResumeThreadId finds an exact resume target through injected options', () => {
  assert.equal(extractCodexResumeThreadId([
    '--remote', 'ws://127.0.0.1:9527',
    'resume',
    '-c', 'model_provider=aih_server',
    '-m', 'gpt-5.6-sol',
    THREAD_ID
  ]), THREAD_ID);
});

test('extractCodexResumeThreadId rejects picker and latest resume forms', () => {
  assert.equal(extractCodexResumeThreadId(['resume']), '');
  assert.equal(extractCodexResumeThreadId(['/resume']), '');
  assert.equal(extractCodexResumeThreadId(['resume', '--last']), '');
});

test('resolveCodexPersistentThreadId prefers the runtime-bound native identity', () => {
  const rebound = '019f9899-873d-77b1-ba91-4a07e555bb59';
  assert.equal(resolveCodexPersistentThreadId({
    nativeSessionId: rebound,
    forwardArgs: ['resume', THREAD_ID]
  }), rebound);
  assert.equal(resolveCodexPersistentThreadId({
    forwardArgs: ['resume', THREAD_ID]
  }), THREAD_ID);
});

test('selectPreferredCodexPersistentOwner applies one deterministic owner order', () => {
  const selected = selectPreferredCodexPersistentOwner([
    { session: 'p-newer-created', updatedAt: 100, createdAt: 20 },
    { session: 'p-older-created', updatedAt: 100, createdAt: 10 },
    { session: 'p-newest-updated', updatedAt: 200, createdAt: 1 }
  ]);

  assert.equal(selected.session, 'p-newest-updated');
  assert.equal(
    selectPreferredCodexPersistentOwner([
      { session: 'p-a', updatedAt: 100, createdAt: 20 },
      { session: 'p-b', updatedAt: 100, createdAt: 20 }
    ]).session,
    'p-b'
  );
});
