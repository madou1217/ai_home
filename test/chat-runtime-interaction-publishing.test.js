'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ChatRuntimePublishingStore } = require('../lib/server/chat-runtime-publishing-store');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const {
  approvalPayload,
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

test('finishing a question publishes the resolved state and user answer in sequence', (t) => {
  const { published, publishing, session } = createFixture(t);
  publishing.createInteraction({
    interactionId: 'question-1', sessionId: session.sessionId,
    itemId: 'question-item-1', kind: 'question', revision: 1,
    payload: questionPayload()
  });
  published.length = 0;
  const claim = publishing.claimInteractionResolution('question-1', {
    sessionId: session.sessionId,
    kind: 'question',
    revision: 1,
    resolution: { action: 'submit', answer: { answer: '保留我的选择' } }
  });
  published.length = 0;

  publishing.finishInteractionResolution(claim);

  assert.deepEqual(published.map(({ type }) => type), [
    'interaction.resolved',
    'timeline.item.completed'
  ]);
  assert.equal(published[1].payload.item.content, '保留我的选择');
  assert.deepEqual(published[1].payload.item.detail, {
    role: 'user', phase: 'interaction_answer'
  });
});

test('releasing an interaction claim republishes the restored pending interaction', (t) => {
  const { published, publishing, session } = createFixture(t);
  publishing.createInteraction({
    interactionId: 'approval-1', sessionId: session.sessionId,
    itemId: 'approval-item-1', kind: 'approval', revision: 1,
    payload: approvalPayload()
  });
  published.length = 0;

  const claim = publishing.claimInteractionResolution('approval-1', {
    sessionId: session.sessionId,
    revision: 1,
    resolution: { decision: 'allow' }
  });
  assert.deepEqual(published.map(({ type }) => type), ['interaction.updated']);
  assert.equal(published[0].payload.interaction.state, 'resolving');
  published.length = 0;
  publishing.releaseInteractionResolution(claim);

  assert.deepEqual(published.map(({ type }) => type), ['interaction.updated']);
  assert.equal(published[0].payload.interaction.state, 'pending');
  assert.equal(publishing.getSnapshot(session.sessionId).interactions.length, 1);
});

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-interaction-publish-'));
  const published = [];
  const store = openChatRuntimeStore({ fs, aiHomeDir, DatabaseSync });
  const publishing = new ChatRuntimePublishingStore({
    store,
    eventHub: { publish: (event) => published.push(event) }
  });
  t.after(() => {
    publishing.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const session = publishing.createSession({
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1'
  });
  return { published, publishing, session };
}
