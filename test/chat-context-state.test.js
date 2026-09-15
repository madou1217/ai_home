'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contextPatch } = require('../lib/server/chat-runtime/chat-context-state');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

test('goal lifecycle is projected into chat context and can be cleared', () => {
  const goal = { threadId: 'thread-1', objective: 'ship', status: 'active', tokenBudget: null,
    tokensUsed: 2, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
  const session = { policy: { workspaceMode: 'chat', contextState: { usedTokens: 5 } } };
  assert.deepEqual(contextPatch(session, { type: 'session.goal.updated', payload: { goal } }), {
    usedTokens: 5, goal, goalSource: 'native'
  });
  assert.deepEqual(contextPatch({ policy: { workspaceMode: 'chat', contextState: { goal, usedTokens: 5 } } },
    { type: 'session.goal.cleared', payload: { goalId: 'thread-1' } }), { usedTokens: 5 });
});

test('native goals project in Work and clear their provenance without altering context usage', () => {
  const goal = { threadId: 'thread-1', objective: 'ship', status: 'paused' };
  const policy = { workspaceMode: 'work', contextState: { usedTokens: 700 } };
  const next = contextPatch({ policy }, { type: 'session.goal.updated', payload: { goal } });
  assert.deepEqual(next, { usedTokens: 700, goal, goalSource: 'native' });
  assert.deepEqual(contextPatch({ policy: { ...policy, contextState: next } }, {
    type: 'session.goal.cleared', payload: { goalId: 'thread-1' }
  }), { usedTokens: 700 });
});

test('an explicit AIH goal event retains its source and a subsequent native mutation replaces it', () => {
  const goal = { threadId: 'thread-1', objective: 'ship', status: 'active' };
  const policy = { workspaceMode: 'chat', contextState: {} };
  const next = contextPatch({ policy }, {
    type: 'session.goal.updated', payload: { goal, goalSource: 'aih' }
  });
  assert.equal(next.goalSource, 'aih');
  const native = contextPatch({ policy: { ...policy, contextState: next } }, {
    type: 'session.goal.updated', payload: { goal: { ...goal, status: 'paused' } }
  });
  assert.equal(native.goalSource, 'native');
});

test('goal projection is durable across a chat runtime store reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-goal-projection-'));
  const goal = { threadId: 'thread-1', objective: 'ship', status: 'active', tokenBudget: null,
    tokensUsed: 2, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
  const store = openChatRuntimeStore({ aiHomeDir: root });
  const session = store.createSession({ sessionId: 'goal-session', provider: 'codex',
    executionAccountRef: 'account-1', policy: { workspaceMode: 'chat' } });
  store.appendEvent(session.sessionId, {
    type: 'session.goal.updated', payload: { goal },
    source: { provider: 'codex', runtimeId: 'codex:account-1' }
  });
  assert.deepEqual(store.getSession(session.sessionId).policy.contextState.goal, goal);
  store.close();
  const reopened = openChatRuntimeStore({ aiHomeDir: root });
  assert.deepEqual(reopened.getSession(session.sessionId).policy.contextState.goal, goal);
  reopened.close();
});
